import { useEffect, useRef, useState } from 'react';
import { PhoneOff, Mic, MicOff, Video as VideoIcon, VideoOff, SwitchCamera } from 'lucide-react';
import { cn } from '../lib/utils';
import { doc, setDoc, onSnapshot, updateDoc, deleteDoc, collection, addDoc, getDoc } from 'firebase/firestore';
import { db } from '../firebase';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';
import { motion } from 'motion/react';

interface CallScreenProps {
  isIncoming: boolean;
  callerName: string;
  callerPhoto: string;
  callId: string;
  isVideo: boolean;
  onEndCall: () => void;
  currentUserId: string;
}

export default function CallScreen({ 
  isIncoming, 
  callerName, 
  callerPhoto, 
  callId, 
  isVideo, 
  onEndCall,
  currentUserId 
}: CallScreenProps) {
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(!isVideo);
  const [callStatus, setCallStatus] = useState(isIncoming ? 'incoming' : 'calling');
  const [mediaError, setMediaError] = useState<string | null>(null);
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  const [hasMultipleCameras, setHasMultipleCameras] = useState(false);
  
  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const peerConnection = useRef<RTCPeerConnection | null>(null);
  const localStream = useRef<MediaStream | null>(null);

  // Ringing sound effect
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ringIntervalRef = useRef<number | null>(null);

  useEffect(() => {
    if (callStatus === 'calling' || callStatus === 'incoming') {
      try {
        const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
        if (!AudioContextClass) return;
        
        const ctx = new AudioContextClass();
        audioCtxRef.current = ctx;

        const playRing = () => {
          if (ctx.state === 'suspended') ctx.resume();
          
          const osc1 = ctx.createOscillator();
          const osc2 = ctx.createOscillator();
          const gainNode = ctx.createGain();

          osc1.type = 'sine';
          osc1.frequency.value = 440;
          
          osc2.type = 'sine';
          osc2.frequency.value = 480;

          osc1.connect(gainNode);
          osc2.connect(gainNode);
          gainNode.connect(ctx.destination);

          // Standard ring pattern: 2 seconds on
          gainNode.gain.setValueAtTime(0, ctx.currentTime);
          gainNode.gain.linearRampToValueAtTime(0.1, ctx.currentTime + 0.05);
          gainNode.gain.setValueAtTime(0.1, ctx.currentTime + 1.95);
          gainNode.gain.linearRampToValueAtTime(0, ctx.currentTime + 2.0);

          osc1.start(ctx.currentTime);
          osc2.start(ctx.currentTime);
          osc1.stop(ctx.currentTime + 2.0);
          osc2.stop(ctx.currentTime + 2.0);
        };

        playRing();
        // Repeat every 4 seconds (2s on, 2s off)
        ringIntervalRef.current = window.setInterval(playRing, 4000);
      } catch (e) {
        console.error("Audio context error:", e);
      }
    }
    
    return () => {
      if (ringIntervalRef.current) clearInterval(ringIntervalRef.current);
      if (audioCtxRef.current && audioCtxRef.current.state !== 'closed') {
        audioCtxRef.current.close().catch(() => {});
      }
    };
  }, [callStatus]);

  useEffect(() => {
    const callDoc = doc(db, 'calls', callId);
    const unsubscribe = onSnapshot(callDoc, (snapshot) => {
      if (!snapshot.exists() || snapshot.data()?.status === 'ended') {
        onEndCall();
      }
    });
    return () => unsubscribe();
  }, [callId, onEndCall]);

  useEffect(() => {
    const setupMedia = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: isVideo ? { facingMode: 'user' } : false,
          audio: true
        });
        
        localStream.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter(device => device.kind === 'videoinput');
          
          // Always show switch button on mobile devices, or if multiple cameras detected
          const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
          setHasMultipleCameras(videoInputs.length > 1 || isMobile);
        } catch (e) {
          console.error("Error enumerating devices", e);
        }

        if (!isIncoming) {
          startCall();
        }
      } catch (error) {
        console.error("Error accessing media devices:", error);
        setMediaError("Could not access camera/microphone. Please check permissions.");
        // If we can't get media, we should end the call in the database so it doesn't hang
        if (!isIncoming) {
          try {
            await updateDoc(doc(db, 'calls', callId), { status: 'ended' });
          } catch (e) {}
        }
      }
    };

    setupMedia();

    return () => {
      localStream.current?.getTracks().forEach(track => track.stop());
      peerConnection.current?.close();
    };
  }, []);

  const setupPeerConnection = () => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }
      ]
    });

    localStream.current?.getTracks().forEach(track => {
      pc.addTrack(track, localStream.current!);
    });

    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = event.streams[0];
      }
    };

    peerConnection.current = pc;
    return pc;
  };

  const startCall = async () => {
    const pc = setupPeerConnection();
    const callDoc = doc(db, 'calls', callId);
    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          await addDoc(offerCandidates, event.candidate.toJSON());
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `calls/${callId}/offerCandidates`);
        }
      }
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };

    try {
      await updateDoc(callDoc, { offer, status: 'calling' });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `calls/${callId}`);
    }

    onSnapshot(callDoc, (snapshot) => {
      const data = snapshot.data();
      if (!pc.currentRemoteDescription && data?.answer) {
        setCallStatus('connected');
        const answerDescription = new RTCSessionDescription(data.answer);
        pc.setRemoteDescription(answerDescription);
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `calls/${callId}`);
    });

    onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          pc.addIceCandidate(candidate);
        }
      });
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `calls/${callId}/answerCandidates`);
    });
  };

  const answerCall = async () => {
    setCallStatus('connected');
    const pc = setupPeerConnection();
    const callDoc = doc(db, 'calls', callId);
    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        try {
          await addDoc(answerCandidates, event.candidate.toJSON());
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `calls/${callId}/answerCandidates`);
        }
      }
    };

    try {
      const callData = (await getDoc(callDoc)).data();
      if (!callData?.offer) return;

      const offerDescription = new RTCSessionDescription(callData.offer);
      await pc.setRemoteDescription(offerDescription);

      const answerDescription = await pc.createAnswer();
      await pc.setLocalDescription(answerDescription);

      const answer = {
        type: answerDescription.type,
        sdp: answerDescription.sdp,
      };

      await updateDoc(callDoc, { answer, status: 'connected' });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `calls/${callId}`);
    }

    onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidate = new RTCIceCandidate(change.doc.data());
          pc.addIceCandidate(candidate);
        }
      });
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `calls/${callId}/offerCandidates`);
    });
  };

  const handleEndCall = async () => {
    try {
      await updateDoc(doc(db, 'calls', callId), { status: 'ended' });
    } catch (e) {
      // Ignore if document already deleted
    }
    onEndCall();
  };

  const toggleMute = () => {
    if (localStream.current) {
      localStream.current.getAudioTracks()[0].enabled = isMuted;
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStream.current) {
      const videoTrack = localStream.current.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.enabled = isVideoOff;
        setIsVideoOff(!isVideoOff);
      }
    }
  };

  const handleSwitchCamera = async () => {
    if (!localStream.current || !isVideo) return;

    const nextFacingMode = facingMode === 'user' ? 'environment' : 'user';

    try {
      const oldVideoTrack = localStream.current.getVideoTracks()[0];
      
      // CRITICAL FOR MOBILE: Stop the current track before requesting the new one.
      // Many mobile devices cannot run front and back cameras simultaneously.
      if (oldVideoTrack) {
        oldVideoTrack.stop();
        localStream.current.removeTrack(oldVideoTrack);
      }
      
      let newStream: MediaStream;
      try {
        // Try exact facing mode first (best for mobile back camera)
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: nextFacingMode === 'environment' ? { exact: 'environment' } : 'user' }
        });
      } catch (err) {
        // Fallback to ideal facing mode if exact fails
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: nextFacingMode }
        });
      }

      const newVideoTrack = newStream.getVideoTracks()[0];
      localStream.current.addTrack(newVideoTrack);

      if (localVideoRef.current) {
        localVideoRef.current.srcObject = localStream.current;
      }

      if (peerConnection.current) {
        const sender = peerConnection.current.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(newVideoTrack);
        }
      }
      
      if (isVideoOff) {
        newVideoTrack.enabled = false;
      }
      
      setFacingMode(nextFacingMode);
    } catch (error) {
      console.error("Error switching camera:", error);
      setMediaError("Could not switch camera. Please try again.");
      setTimeout(() => setMediaError(null), 3000);
      
      // Try to recover original camera if switch failed
      try {
        const recoveryStream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode }
        });
        const recoveryTrack = recoveryStream.getVideoTracks()[0];
        localStream.current.addTrack(recoveryTrack);
        if (localVideoRef.current) localVideoRef.current.srcObject = localStream.current;
        if (peerConnection.current) {
          const sender = peerConnection.current.getSenders().find(s => s.track?.kind === 'video');
          if (sender) await sender.replaceTrack(recoveryTrack);
        }
      } catch (e) {
        console.error("Recovery failed", e);
      }
    }
  };

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="fixed inset-0 z-[100] bg-black/90 backdrop-blur-xl flex flex-col items-center justify-center"
    >
      {mediaError && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 bg-red-500 text-white px-4 py-2 rounded-lg z-[200] shadow-xl text-sm md:text-base text-center w-[90%] max-w-md">
          {mediaError}
        </div>
      )}

      {/* Remote Media (Always rendered for audio, hidden if not video) */}
      <video 
        ref={remoteVideoRef} 
        autoPlay 
        playsInline 
        className={cn(
          "absolute inset-0 w-full h-full object-cover",
          (!isVideo || callStatus !== 'connected') ? "hidden" : ""
        )}
      />

      {/* Local Video (PiP) */}
      {isVideo && (
        <div className="absolute top-20 right-4 md:top-6 md:right-6 w-28 h-40 sm:w-48 sm:h-72 bg-zinc-800 rounded-2xl overflow-hidden border-2 border-glass-border shadow-2xl z-20">
          <video 
            ref={localVideoRef} 
            autoPlay 
            playsInline 
            muted 
            className={cn("w-full h-full object-cover", isVideoOff && "hidden")}
          />
          {isVideoOff && (
            <div className="w-full h-full flex items-center justify-center bg-zinc-900">
              <VideoOff className="w-8 h-8 text-zinc-500" />
            </div>
          )}
        </div>
      )}

      {/* Call Info Overlay */}
      <motion.div 
        layout
        className={cn(
          "z-10 flex flex-col items-center transition-all duration-500",
          callStatus === 'connected' && isVideo ? "absolute top-12 left-1/2 -translate-x-1/2 scale-75 md:scale-100" : "mt-0"
        )}
      >
        <motion.img 
          layoutId="callerPhoto"
          src={callerPhoto} 
          alt={callerName} 
          className="w-32 h-32 rounded-full object-cover border-4 border-white/10 shadow-2xl mb-6"
        />
        <motion.h2 layoutId="callerName" className="text-3xl font-medium text-white mb-2">{callerName}</motion.h2>
        <p className="text-zinc-400 capitalize">
          {callStatus === 'incoming' ? 'Incoming call...' : 
           callStatus === 'calling' ? 'Calling...' : 
           'Connected'}
        </p>
      </motion.div>

      {/* Controls */}
      <motion.div 
        initial={{ y: 50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.2 }}
        className="absolute bottom-10 md:bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-4 md:gap-6 z-20 bg-black/40 p-3 md:p-4 rounded-full backdrop-blur-md border border-white/10"
      >
        {callStatus === 'incoming' ? (
          <>
            <button 
              onClick={handleEndCall}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-transform hover:scale-105 active:scale-95 shadow-lg shadow-red-500/20"
            >
              <PhoneOff className="w-7 h-7" />
            </button>
            <button 
              onClick={answerCall}
              className="w-16 h-16 rounded-full bg-green-500 hover:bg-green-600 flex items-center justify-center text-white transition-transform hover:scale-105 active:scale-95 shadow-lg shadow-green-500/20"
            >
              {isVideo ? <VideoIcon className="w-7 h-7" /> : <PhoneOff className="w-7 h-7 rotate-[135deg]" />}
            </button>
          </>
        ) : (
          <>
            <button 
              onClick={toggleMute}
              className={cn(
                "w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95",
                isMuted ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20 backdrop-blur-md border border-white/10"
              )}
            >
              {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </button>
            
            {isVideo && (
              <button 
                onClick={toggleVideo}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95",
                  isVideoOff ? "bg-white text-black" : "bg-white/10 text-white hover:bg-white/20 backdrop-blur-md border border-white/10"
                )}
              >
                {isVideoOff ? <VideoOff className="w-6 h-6" /> : <VideoIcon className="w-6 h-6" />}
              </button>
            )}

            {isVideo && hasMultipleCameras && (
              <button 
                onClick={handleSwitchCamera}
                className="w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-105 active:scale-95 bg-white/10 text-white hover:bg-white/20 backdrop-blur-md border border-white/10"
                title="Switch Camera"
              >
                <SwitchCamera className="w-6 h-6" />
              </button>
            )}

            <button 
              onClick={handleEndCall}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-transform hover:scale-105 active:scale-95 shadow-lg shadow-red-500/20"
            >
              <PhoneOff className="w-7 h-7" />
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
