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
  const [isMediaReady, setIsMediaReady] = useState(false);
  
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

  const unsubscribeCallRef = useRef<(() => void) | null>(null);
  const unsubscribeCandidatesRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let isMounted = true;
    let stream: MediaStream | null = null;

    const setupMedia = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: isVideo ? { 
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          } : false,
          audio: true
        });
        
        if (!isMounted) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        localStream.current = stream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        setIsMediaReady(true);

        try {
          const devices = await navigator.mediaDevices.enumerateDevices();
          const videoInputs = devices.filter(device => device.kind === 'videoinput');
          
          // Always show switch button on mobile devices, or if multiple cameras detected
          const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);
          if (isMounted) setHasMultipleCameras(videoInputs.length > 1 || isMobile);
        } catch (e) {
          console.error("Error enumerating devices", e);
        }

        if (!isIncoming && isMounted) {
          startCall();
        }
      } catch (error) {
        if (!isMounted) return;
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
      isMounted = false;
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
      if (localStream.current === stream) {
        localStream.current = null;
      }
      if (peerConnection.current) {
        peerConnection.current.close();
        peerConnection.current = null;
      }
      if (unsubscribeCallRef.current) unsubscribeCallRef.current();
      if (unsubscribeCandidatesRef.current) unsubscribeCandidatesRef.current();
    };
  }, []);

  const setupPeerConnection = () => {
    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' }
      ]
    });

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => {
        pc.addTrack(track, localStream.current!);
      });
    }

    pc.ontrack = (event) => {
      if (remoteVideoRef.current) {
        if (event.streams && event.streams[0]) {
          if (remoteVideoRef.current.srcObject !== event.streams[0]) {
            remoteVideoRef.current.srcObject = event.streams[0];
          }
        } else {
          if (!remoteVideoRef.current.srcObject) {
            remoteVideoRef.current.srcObject = new MediaStream();
          }
          (remoteVideoRef.current.srcObject as MediaStream).addTrack(event.track);
        }
        
        // Ensure video plays
        const playPromise = remoteVideoRef.current.play();
        if (playPromise !== undefined) {
          playPromise.catch(error => {
            if (error.name !== 'AbortError') {
              console.error("Auto-play was prevented:", error);
            }
          });
        }
      }
    };

    pc.oniceconnectionstatechange = () => {
      console.log("ICE State:", pc.iceConnectionState);
      if (pc.iceConnectionState === 'failed') {
        setMediaError("Network connection failed. You may be behind a strict firewall.");
      } else if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
        setMediaError(null);
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
        if (peerConnection.current !== pc) return;
        try {
          await addDoc(offerCandidates, event.candidate.toJSON());
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `calls/${callId}/offerCandidates`);
        }
      }
    };

    const offerDescription = await pc.createOffer();
    await pc.setLocalDescription(offerDescription);

    if (peerConnection.current !== pc) return;

    const offer = {
      sdp: offerDescription.sdp,
      type: offerDescription.type,
    };

    try {
      await updateDoc(callDoc, { offer, status: 'calling' });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `calls/${callId}`);
    }

    let candidatesQueue: RTCIceCandidateInit[] = [];
    let isRemoteDescriptionSet = false;
    let isSettingRemoteDescription = false;

    unsubscribeCallRef.current = onSnapshot(callDoc, async (snapshot) => {
      const data = snapshot.data();
      if (!isRemoteDescriptionSet && !isSettingRemoteDescription && data?.answer) {
        isSettingRemoteDescription = true;
        try {
          const answerDescription = new RTCSessionDescription(data.answer);
          await pc.setRemoteDescription(answerDescription);
          isRemoteDescriptionSet = true;
          setCallStatus('connected');
          
          // Process any queued candidates now that remote description is set
          for (const candidate of candidatesQueue) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
          }
          candidatesQueue = [];
        } catch (err) {
          console.error("Failed to set remote description:", err);
          isSettingRemoteDescription = false;
        }
      }
    }, (error) => {
      handleFirestoreError(error, OperationType.GET, `calls/${callId}`);
    });

    unsubscribeCandidatesRef.current = onSnapshot(answerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidateData = change.doc.data() as RTCIceCandidateInit;
          if (isRemoteDescriptionSet) {
            pc.addIceCandidate(new RTCIceCandidate(candidateData)).catch(console.error);
          } else {
            candidatesQueue.push(candidateData);
          }
        }
      });
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `calls/${callId}/answerCandidates`);
    });
  };

  const answerCall = async () => {
    if (peerConnection.current) return;
    setCallStatus('connected');
    const pc = setupPeerConnection();
    const callDoc = doc(db, 'calls', callId);
    const offerCandidates = collection(callDoc, 'offerCandidates');
    const answerCandidates = collection(callDoc, 'answerCandidates');

    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        if (peerConnection.current !== pc) return;
        try {
          await addDoc(answerCandidates, event.candidate.toJSON());
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `calls/${callId}/answerCandidates`);
        }
      }
    };

    let candidatesQueue: RTCIceCandidateInit[] = [];
    let isRemoteDescriptionSet = false;
    let isSettingRemoteDescription = false;

    unsubscribeCallRef.current = onSnapshot(callDoc, async (snapshot) => {
      const callData = snapshot.data();
      if (!isRemoteDescriptionSet && !isSettingRemoteDescription && callData?.offer) {
        isSettingRemoteDescription = true;
        try {
          const offerDescription = new RTCSessionDescription(callData.offer);
          await pc.setRemoteDescription(offerDescription);
          isRemoteDescriptionSet = true;

          const answerDescription = await pc.createAnswer();
          await pc.setLocalDescription(answerDescription);

          if (peerConnection.current !== pc) return;

          const answer = {
            type: answerDescription.type,
            sdp: answerDescription.sdp,
          };

          await updateDoc(callDoc, { answer, status: 'connected' });
          
          // Process any candidates that arrived while we were setting up
          for (const candidate of candidatesQueue) {
            await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(console.error);
          }
          candidatesQueue = [];
        } catch (error) {
          handleFirestoreError(error, OperationType.WRITE, `calls/${callId}`);
          isSettingRemoteDescription = false;
        }
      }
    });

    unsubscribeCandidatesRef.current = onSnapshot(offerCandidates, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const candidateData = change.doc.data() as RTCIceCandidateInit;
          if (isRemoteDescriptionSet) {
            pc.addIceCandidate(new RTCIceCandidate(candidateData)).catch(console.error);
          } else {
            candidatesQueue.push(candidateData);
          }
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
          video: { 
            facingMode: nextFacingMode === 'environment' ? { exact: 'environment' } : 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
        });
      } catch (err) {
        // Fallback to ideal facing mode if exact fails
        newStream = await navigator.mediaDevices.getUserMedia({
          video: { 
            facingMode: nextFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
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
          video: { 
            facingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          }
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

  const [callDuration, setCallDuration] = useState(0);

  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (callStatus === 'connected') {
      interval = setInterval(() => {
        setCallDuration(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [callStatus]);

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  return (
    <motion.div 
      initial={{ opacity: 0, scale: 0.95 }}
      animate={{ opacity: 1, scale: 1 }}
      exit={{ opacity: 0, scale: 0.95 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
      className="fixed inset-0 z-[100] bg-zinc-950 flex flex-col items-center justify-center overflow-hidden"
    >
      {/* Blurred Background for Audio/Connecting */}
      {(!isVideo || callStatus !== 'connected') && (
        <div className="absolute inset-0 z-0">
          <img src={callerPhoto} alt="Background" className="w-full h-full object-cover opacity-30 blur-3xl scale-110" />
          <div className="absolute inset-0 bg-black/40 mix-blend-overlay"></div>
        </div>
      )}

      {mediaError && (
        <div className="absolute top-12 left-1/2 -translate-x-1/2 bg-red-500/90 backdrop-blur-md text-white px-6 py-3 rounded-full z-[200] shadow-2xl text-sm md:text-base text-center max-w-[90%] border border-red-400/50">
          {mediaError}
        </div>
      )}

      {/* Remote Media */}
      <video 
        ref={remoteVideoRef} 
        autoPlay 
        playsInline 
        className={cn(
          "absolute inset-0 w-full h-full object-cover transition-all duration-700 z-10",
          (!isVideo || callStatus !== 'connected') ? "opacity-0 scale-105 pointer-events-none" : "opacity-100 scale-100"
        )}
      />

      {/* Local Video (PiP) */}
      {isVideo && (
        <motion.div 
          initial={{ opacity: 0, x: 20 }}
          animate={{ opacity: 1, x: 0 }}
          className="absolute top-20 right-4 md:top-8 md:right-8 w-32 h-48 sm:w-48 sm:h-72 bg-zinc-800 rounded-2xl overflow-hidden border border-white/20 shadow-[0_0_30px_rgba(255,255,255,0.1)] z-30 transition-all hover:scale-105 cursor-pointer backdrop-blur-xl"
        >
          <video 
            ref={localVideoRef} 
            autoPlay 
            playsInline 
            muted 
            className={cn("w-full h-full object-cover transition-opacity duration-300", isVideoOff ? "opacity-0" : "opacity-100")}
          />
          {isVideoOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-zinc-900/90 backdrop-blur-sm">
              <VideoOff className="w-8 h-8 text-zinc-500" />
            </div>
          )}
        </motion.div>
      )}

      {/* Call Info Overlay */}
      <motion.div 
        layout
        className={cn(
          "z-20 flex flex-col items-center transition-all duration-700 ease-in-out",
          callStatus === 'connected' && isVideo 
            ? "absolute top-8 left-8 items-start scale-90 origin-top-left bg-black/40 p-4 rounded-2xl backdrop-blur-md border border-white/10" 
            : "mt-0 items-center"
        )}
      >
        <motion.div layoutId="callerPhotoContainer" className="relative mb-6">
          <div className="absolute inset-0 rounded-full bg-purple-500/30 blur-2xl animate-pulse-slow scale-150"></div>
          <motion.img 
            layoutId="callerPhoto"
            src={callerPhoto} 
            alt={callerName} 
            className={cn(
              "relative rounded-full object-cover border-4 border-white/20 shadow-[0_0_40px_rgba(255,255,255,0.2)] transition-all duration-700 z-10",
              callStatus === 'connected' && isVideo ? "w-16 h-16 mb-0 border-2" : "w-36 h-36"
            )}
          />
          {callStatus === 'calling' && (
            <div className="absolute inset-0 rounded-full border-4 border-green-400/50 animate-ping z-20"></div>
          )}
        </motion.div>
        
        <motion.h2 layoutId="callerName" className={cn(
          "font-semibold text-white tracking-tight transition-all duration-700",
          callStatus === 'connected' && isVideo ? "text-xl mt-2" : "text-4xl mb-2"
        )}>
          {callerName}
        </motion.h2>
        
        <p className={cn(
          "text-zinc-300 font-medium tracking-wide transition-all duration-700",
          callStatus === 'connected' && isVideo ? "text-sm" : "text-lg"
        )}>
          {callStatus === 'incoming' ? 'Incoming call...' : 
           callStatus === 'calling' ? 'Calling...' : 
           formatDuration(callDuration)}
        </p>
      </motion.div>

      {/* Controls */}
      <motion.div 
        initial={{ y: 100, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.3, type: "spring", stiffness: 200, damping: 20 }}
        className="absolute bottom-12 left-1/2 -translate-x-1/2 flex items-center gap-4 md:gap-6 z-30 bg-white/10 p-4 md:p-5 rounded-[2.5rem] backdrop-blur-3xl border border-white/20 shadow-[0_8px_32px_0_rgba(255,255,255,0.1)]"
      >
        {callStatus === 'incoming' ? (
          <>
            <button 
              onClick={handleEndCall}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-all hover:scale-110 active:scale-95 shadow-lg shadow-red-500/30"
            >
              <PhoneOff className="w-7 h-7" />
            </button>
            <button 
              onClick={answerCall}
              disabled={!isMediaReady}
              className={cn(
                "w-16 h-16 rounded-full flex items-center justify-center text-white transition-all shadow-lg",
                isMediaReady ? "bg-green-500 hover:bg-green-600 hover:scale-110 active:scale-95 shadow-green-500/30 animate-bounce" : "bg-green-500/40 cursor-not-allowed"
              )}
            >
              {isVideo ? <VideoIcon className="w-7 h-7" /> : <PhoneOff className="w-7 h-7 rotate-[135deg]" />}
            </button>
          </>
        ) : (
          <>
            <button 
              onClick={toggleMute}
              className={cn(
                "w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95",
                isMuted ? "bg-white text-black shadow-lg shadow-white/20" : "bg-white/10 text-white hover:bg-white/20 border border-white/10"
              )}
            >
              {isMuted ? <MicOff className="w-6 h-6" /> : <Mic className="w-6 h-6" />}
            </button>
            
            {isVideo && (
              <button 
                onClick={toggleVideo}
                className={cn(
                  "w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95",
                  isVideoOff ? "bg-white text-black shadow-lg shadow-white/20" : "bg-white/10 text-white hover:bg-white/20 border border-white/10"
                )}
              >
                {isVideoOff ? <VideoOff className="w-6 h-6" /> : <VideoIcon className="w-6 h-6" />}
              </button>
            )}

            {isVideo && hasMultipleCameras && (
              <button 
                onClick={handleSwitchCamera}
                className="w-14 h-14 rounded-full flex items-center justify-center transition-all hover:scale-110 active:scale-95 bg-white/10 text-white hover:bg-white/20 border border-white/10"
                title="Switch Camera"
              >
                <SwitchCamera className="w-6 h-6" />
              </button>
            )}

            <div className="w-px h-8 bg-white/20 mx-2"></div>

            <button 
              onClick={handleEndCall}
              className="w-16 h-16 rounded-full bg-red-500 hover:bg-red-600 flex items-center justify-center text-white transition-all hover:scale-110 active:scale-95 shadow-lg shadow-red-500/30"
            >
              <PhoneOff className="w-7 h-7" />
            </button>
          </>
        )}
      </motion.div>
    </motion.div>
  );
}
