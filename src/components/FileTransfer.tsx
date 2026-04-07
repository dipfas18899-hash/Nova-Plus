import React, { useEffect, useRef, useState } from 'react';
import { doc, updateDoc, onSnapshot, collection, addDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../firebase';
import { Check, File as FileIcon, Loader2 } from 'lucide-react';
import { motion } from 'motion/react';

interface FileTransferProps {
  transferId: string;
  isSender: boolean;
  file?: File;
  transferData: any;
  currentUserId: string;
  onClose: () => void;
}

export default function FileTransfer({ transferId, isSender, file, transferData, currentUserId, onClose }: FileTransferProps) {
  const [status, setStatus] = useState(transferData.status);
  const [progress, setProgress] = useState(0);
  const [speed, setSpeed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef(0);
  const statusRef = useRef(transferData.status);
  const lastTimeRef = useRef(Date.now());
  const lastBytesRef = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  useEffect(() => {
    let unsubscribeDoc: () => void;
    let unsubscribeOfferCands: () => void;
    let unsubscribeAnswerCands: () => void;

    const setupWebRTC = async () => {
      const pc = new RTCPeerConnection({
        iceServers: [
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          { urls: 'stun:stun3.l.google.com:19302' },
          { urls: 'stun:stun4.l.google.com:19302' }
        ]
      });
      pcRef.current = pc;

      const transferRef = doc(db, 'file_transfers', transferId);
      const offerCandidatesRef = collection(transferRef, 'offerCandidates');
      const answerCandidatesRef = collection(transferRef, 'answerCandidates');

      if (isSender && file) {
        const dc = pc.createDataChannel('fileTransfer');
        dcRef.current = dc;
        dc.binaryType = 'arraybuffer';
        dc.bufferedAmountLowThreshold = 1024 * 512; // 512KB

        dc.onopen = () => {
          setStatus('transferring');
          sendFile(file, dc);
        };

        dc.onclose = () => {
          if (statusRef.current !== 'completed' && statusRef.current !== 'canceled' && statusRef.current !== 'rejected') {
            setError('Connection closed unexpectedly');
          }
        };

        pc.onicecandidate = (event) => {
          if (event.candidate) {
            addDoc(offerCandidatesRef, event.candidate.toJSON()).catch(e => console.error(e));
          }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await updateDoc(transferRef, {
          offer: { type: offer.type, sdp: offer.sdp },
          status: 'pending'
        });

        unsubscribeDoc = onSnapshot(transferRef, (snap) => {
          const data = snap.data();
          if (!data) return;
          setStatus(data.status);
          
          if (data.status === 'rejected') {
            setError('Transfer rejected by receiver');
            pc.close();
          } else if (data.status === 'canceled') {
            setError('Transfer canceled');
            pc.close();
          } else if (data.answer && !pc.currentRemoteDescription) {
            pc.setRemoteDescription(new RTCSessionDescription(data.answer)).catch(e => console.error(e));
          }
        });

        unsubscribeAnswerCands = onSnapshot(answerCandidatesRef, (snap) => {
          snap.docChanges().forEach(change => {
            if (change.type === 'added') {
              pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(e => console.error(e));
            }
          });
        });

      } else {
        unsubscribeDoc = onSnapshot(transferRef, async (snap) => {
          const data = snap.data();
          if (!data) return;
          setStatus(data.status);

          if (data.status === 'accepted' && !pc.currentRemoteDescription && data.offer) {
            pc.onicecandidate = (event) => {
              if (event.candidate) {
                addDoc(answerCandidatesRef, event.candidate.toJSON()).catch(e => console.error(e));
              }
            };

            pc.ondatachannel = (event) => {
              const dc = event.channel;
              dcRef.current = dc;
              dc.binaryType = 'arraybuffer';
              
              dc.onmessage = (e) => {
                if (typeof e.data === 'string' && e.data === 'EOF') {
                  const blob = new Blob(receiveBufferRef.current, { type: transferData.fileType });
                  const url = URL.createObjectURL(blob);
                  const a = document.createElement('a');
                  a.href = url;
                  a.download = transferData.fileName;
                  a.click();
                  URL.revokeObjectURL(url);
                  
                  setStatus('completed');
                  updateDoc(transferRef, { status: 'completed' }).catch(e => console.error(e));
                } else {
                  receiveBufferRef.current.push(e.data);
                  receivedBytesRef.current += e.data.byteLength;
                  const currentBytes = receivedBytesRef.current;
                  setProgress((currentBytes / transferData.fileSize) * 100);

                  const now = Date.now();
                  const timeDiff = now - lastTimeRef.current;
                  if (timeDiff >= 500) {
                    const bytesDiff = currentBytes - lastBytesRef.current;
                    setSpeed((bytesDiff / timeDiff) * 1000);
                    lastTimeRef.current = now;
                    lastBytesRef.current = currentBytes;
                  }
                }
              };

              dc.onclose = () => {
                if (statusRef.current !== 'completed' && statusRef.current !== 'canceled' && statusRef.current !== 'rejected') {
                  setError('Connection closed unexpectedly');
                }
              };
            };

            await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            await updateDoc(transferRef, {
              answer: { type: answer.type, sdp: answer.sdp },
              status: 'transferring'
            });

            unsubscribeOfferCands = onSnapshot(offerCandidatesRef, (candsSnap) => {
              candsSnap.docChanges().forEach(change => {
                if (change.type === 'added') {
                  pc.addIceCandidate(new RTCIceCandidate(change.doc.data())).catch(e => console.error(e));
                }
              });
            });
          } else if (data.status === 'canceled') {
            setError('Transfer canceled by sender');
            pc.close();
          }
        });
      }
    };

    setupWebRTC();

    return () => {
      if (unsubscribeDoc) unsubscribeDoc();
      if (unsubscribeOfferCands) unsubscribeOfferCands();
      if (unsubscribeAnswerCands) unsubscribeAnswerCands();
      if (pcRef.current) pcRef.current.close();
    };
  }, []);

  const sendFile = (file: File, dc: RTCDataChannel) => {
    const chunkSize = 65536; // 64KB chunks for high speed
    let offset = 0;
    dc.bufferedAmountLowThreshold = 1024 * 1024 * 4; // 4MB buffer

    lastTimeRef.current = Date.now();
    lastBytesRef.current = 0;

    const readSlice = (o: number) => {
      const slice = file.slice(offset, o + chunkSize);
      const reader = new FileReader();
      reader.onload = (e) => {
        if (!e.target || !e.target.result) return;
        
        const data = e.target.result as ArrayBuffer;
        try {
          if (dc.readyState !== 'open') return;
          dc.send(data);
          offset += data.byteLength;
          setProgress((offset / file.size) * 100);

          const now = Date.now();
          const timeDiff = now - lastTimeRef.current;
          if (timeDiff >= 500) {
            const bytesDiff = offset - lastBytesRef.current;
            setSpeed((bytesDiff / timeDiff) * 1000);
            lastTimeRef.current = now;
            lastBytesRef.current = offset;
          }
          
          if (offset < file.size) {
            if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
              dc.onbufferedamountlow = () => {
                dc.onbufferedamountlow = null;
                readSlice(offset);
              };
            } else {
              readSlice(offset);
            }
          } else {
            dc.send('EOF');
            setStatus('completed');
            
            const chatId = [transferData.senderId, transferData.receiverId].sort().join('_');
            addDoc(collection(db, 'chats', chatId, 'messages'), {
              type: 'file_transfer',
              text: `Shared file: ${transferData.fileName}`,
              senderId: transferData.senderId,
              receiverId: transferData.receiverId,
              timestamp: serverTimestamp(),
            }).catch(e => console.error('Failed to log file transfer', e));
            
            updateDoc(doc(db, 'chats', chatId), {
              lastMessage: `📁 File: ${transferData.fileName}`,
              lastMessageTime: serverTimestamp(),
              lastMessageSenderId: transferData.senderId
            }).catch(e => console.error(e));
          }
        } catch (err) {
          console.error('Error sending chunk', err);
          setError('Failed to send file');
        }
      };
      reader.readAsArrayBuffer(slice);
    };

    readSlice(0);
  };

  const handleAccept = async () => {
    await updateDoc(doc(db, 'file_transfers', transferId), { status: 'accepted' });
  };

  const handleReject = async () => {
    await updateDoc(doc(db, 'file_transfers', transferId), { status: 'rejected' });
    onClose();
  };

  const handleCancel = async () => {
    await updateDoc(doc(db, 'file_transfers', transferId), { status: 'canceled' });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
      <motion.div 
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="bg-zinc-900 border border-glass-border p-6 rounded-2xl max-w-sm w-full shadow-2xl"
      >
        <div className="flex items-center gap-4 mb-6">
          <div className="w-12 h-12 rounded-full bg-blue-500/20 flex items-center justify-center text-blue-400 shrink-0">
            <FileIcon className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0">
            <h3 className="font-medium text-white truncate">{transferData.fileName}</h3>
            <p className="text-sm text-zinc-400">{(transferData.fileSize / 1024 / 1024).toFixed(2)} MB</p>
          </div>
        </div>

        {error ? (
          <div className="text-red-400 text-sm text-center mb-6">{error}</div>
        ) : status === 'initializing' || status === 'pending' ? (
          <div className="text-center mb-6">
            {isSender ? (
              <p className="text-zinc-400 text-sm flex items-center justify-center gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Waiting for receiver to accept...
              </p>
            ) : (
              <p className="text-zinc-300 text-sm">Someone wants to send you a file directly.</p>
            )}
          </div>
        ) : status === 'transferring' ? (
          <div className="mb-6">
            <div className="flex justify-between text-xs text-zinc-400 mb-2">
              <span>{isSender ? 'Uploading...' : 'Downloading...'}</span>
              <div className="flex gap-3">
                {speed > 0 && <span className="text-blue-400">{(speed / 1024 / 1024).toFixed(1)} MB/s</span>}
                <span className="text-white font-medium">{Math.round(progress)}%</span>
              </div>
            </div>
            <div className="w-full bg-zinc-800 rounded-full h-2 overflow-hidden">
              <div className="bg-blue-500 h-full transition-all duration-300" style={{ width: `${progress}%` }}></div>
            </div>
          </div>
        ) : status === 'completed' ? (
          <div className="text-green-400 text-sm text-center mb-6 flex items-center justify-center gap-2">
            <Check className="w-4 h-4" /> Transfer complete!
          </div>
        ) : null}

        <div className="flex gap-3">
          {status === 'pending' && !isSender && (
            <>
              <button onClick={handleReject} className="flex-1 py-2 rounded-xl bg-zinc-800 text-white hover:bg-zinc-700 transition-colors">Decline</button>
              <button onClick={handleAccept} className="flex-1 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-500 transition-colors">Accept</button>
            </>
          )}
          {((status === 'initializing' || status === 'pending') && isSender) || status === 'transferring' ? (
            <button onClick={handleCancel} className="w-full py-2 rounded-xl bg-red-500/20 text-red-400 hover:bg-red-500/30 transition-colors">Cancel</button>
          ) : null}
          {(status === 'completed' || error || status === 'rejected' || status === 'canceled') && (
            <button onClick={onClose} className="w-full py-2 rounded-xl bg-zinc-800 text-white hover:bg-zinc-700 transition-colors">Close</button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
