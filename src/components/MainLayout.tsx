import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { auth, db } from '../firebase';
import { signOut } from 'firebase/auth';
import { collection, query, where, onSnapshot, orderBy, doc, setDoc, serverTimestamp, getDocs, addDoc, updateDoc } from 'firebase/firestore';
import { LogOut, Search, Phone, Video, MoreVertical, Send, User as UserIcon, ChevronLeft, Mic, Square, Paperclip, Bell, BellOff, Maximize, Minimize, Smile } from 'lucide-react';
import { cn } from '../lib/utils';
import { format } from 'date-fns';
import CallScreen from './CallScreen';
import FileTransfer from './FileTransfer';
import GifPicker from './GifPicker';
import { handleFirestoreError, OperationType } from '../lib/firestore-errors';
import { motion, AnimatePresence } from 'motion/react';

export default function MainLayout() {
  const { user } = useAuth();
  const [users, setUsers] = useState<any[]>([]);
  const [selectedUser, setSelectedUser] = useState<any | null>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  
  // New states for editing name
  const [currentUserData, setCurrentUserData] = useState<any>(null);
  const [showMenu, setShowMenu] = useState(false);
  const [isEditingName, setIsEditingName] = useState(false);
  const [editNameInput, setEditNameInput] = useState('');
  
  // Voice recording state
  const [isRecording, setIsRecording] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // GIF state
  const [showGifPicker, setShowGifPicker] = useState(false);
  
  // Call state
  const [activeCall, setActiveCall] = useState<any | null>(null);

  // File transfer state
  const [activeTransfer, setActiveTransfer] = useState<{ id: string, isSender: boolean, file?: File, data: any } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Notifications state
  const notifiedIds = useRef<Set<string>>(new Set());
  const [toasts, setToasts] = useState<{id: string, title: string, body: string}[]>([]);
  const [notifPermission, setNotifPermission] = useState<NotificationPermission>(
    "Notification" in window ? Notification.permission : "default"
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(err => {
        console.error(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      if (document.exitFullscreen) {
        document.exitFullscreen();
      }
    }
  };

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(console.error);
    }
  }, []);

  const requestNotificationPermission = async () => {
    if ("Notification" in window) {
      const perm = await Notification.requestPermission();
      setNotifPermission(perm);
      if (perm === 'granted') {
        showNotification('Notifications Enabled', 'You will now receive alerts for new messages and calls.');
      }
    }
  };

  const playNotificationSound = () => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(1200, ctx.currentTime + 0.1);

      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.05);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.3);

      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + 0.3);
    } catch (e) {}
  };

  const showNotification = async (title: string, body: string) => {
    playNotificationSound();

    if ("Notification" in window && Notification.permission === "granted") {
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.ready;
          if (reg && reg.showNotification) {
            await reg.showNotification(title, {
              body,
              icon: '/vite.svg',
              vibrate: [200, 100, 200]
            } as any);
            return; // If successful, don't show toast
          }
        }
        new Notification(title, { body, icon: '/vite.svg' });
        return; // If successful, don't show toast
      } catch (e) {
        // Fallback if native fails
        console.error("Native notification failed:", e);
      }
    }
    
    // Fallback to in-app toast notification
    const id = Math.random().toString(36).substring(2, 9);
    setToasts(prev => [...prev, { id, title, body }]);
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 5000);
  };

  // Time state for presence heartbeat
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10000);
    return () => clearInterval(interval);
  }, []);

  const checkIsOnline = (u: any) => {
    if (!u) return false;
    if (u.status === 'offline') return false;
    
    if (u.lastSeen) {
      const lastSeenMs = u.lastSeen.toMillis ? u.lastSeen.toMillis() : u.lastSeen.seconds * 1000;
      // If last seen was more than 60 seconds ago, consider offline
      if (now - lastSeenMs > 60000) {
        return false;
      }
    }
    return u.status === 'online';
  };

  // Typing sound effect
  const audioCtxRef = useRef<AudioContext | null>(null);

  const playTypingSound = () => {
    try {
      if (!audioCtxRef.current) {
        audioCtxRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioCtxRef.current;
      if (ctx.state === 'suspended') ctx.resume();
      
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      
      osc.type = 'sine';
      osc.frequency.setValueAtTime(800, ctx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(300, ctx.currentTime + 0.05);
      
      gain.gain.setValueAtTime(0.02, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.05);
      
      osc.start();
      osc.stop(ctx.currentTime + 0.05);
    } catch (e) {
      // Ignore audio errors
    }
  };

  // Fetch users
  useEffect(() => {
    if (!user) return;
    
    const q = query(collection(db, 'users'), where('uid', '!=', user.uid));
    const unsubscribe = onSnapshot(q, (snapshot) => {
      const usersData = snapshot.docs.map(doc => doc.data());
      setUsers(usersData);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'users');
    });

    const unsubscribeMe = onSnapshot(doc(db, 'users', user.uid), (docSnap) => {
      if (docSnap.exists()) {
        setCurrentUserData(docSnap.data());
      }
    });

    return () => {
      unsubscribe();
      unsubscribeMe();
    };
  }, [user]);

  const getDisplayName = (u: any) => {
    if (!u) return '';
    return currentUserData?.nicknames?.[u.uid] || u.displayName;
  };

  // Listen for incoming calls
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'calls'), 
      where('receiverId', '==', user.uid),
      where('status', 'in', ['calling', 'connected'])
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const callData = change.doc.data();
        
        if (change.type === 'added') {
          // Find caller details
          const caller = users.find(u => u.uid === callData.callerId);
          if (caller) {
            const callerName = currentUserData?.nicknames?.[caller.uid] || caller.displayName;
            setActiveCall({
              id: change.doc.id,
              isIncoming: true,
              callerName,
              callerPhoto: caller.photoURL,
              isVideo: callData.isVideo,
            });

            if (!notifiedIds.current.has(`call_${change.doc.id}`)) {
              notifiedIds.current.add(`call_${change.doc.id}`);
              showNotification(
                callData.isVideo ? 'Incoming Video Call' : 'Incoming Audio Call',
                `${callerName} is calling you`
              );
            }
          }
        }
        
        if (change.type === 'modified') {
          if (callData.status === 'ended' || callData.status === 'rejected') {
            setActiveCall(null);
          }
        }
        
        if (change.type === 'removed') {
          setActiveCall(null);
        }
      });
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'calls');
    });

    return () => unsubscribe();
  }, [user, users, currentUserData]);

  // Listen for incoming file transfers
  useEffect(() => {
    if (!user) return;

    const q = query(
      collection(db, 'file_transfers'), 
      where('receiverId', '==', user.uid),
      where('status', '==', 'pending')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added') {
          const data = change.doc.data();
          setActiveTransfer({
            id: change.doc.id,
            isSender: false,
            data
          });

          if (!notifiedIds.current.has(`file_${change.doc.id}`)) {
            notifiedIds.current.add(`file_${change.doc.id}`);
            const sender = users.find(u => u.uid === data.senderId);
            const senderName = currentUserData?.nicknames?.[data.senderId] || sender?.displayName || 'Someone';
            showNotification('Incoming File', `${senderName} wants to send you: ${data.fileName}`);
          }
        }
      });
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, 'file_transfers');
    });

    return () => unsubscribe();
  }, [user, users, currentUserData]);

  // Fetch messages when a user is selected
  useEffect(() => {
    if (!user || !selectedUser) return;

    const chatId = [user.uid, selectedUser.uid].sort().join('_');
    const q = query(
      collection(db, 'chats', chatId, 'messages'),
      orderBy('timestamp', 'asc')
    );

    const unsubscribe = onSnapshot(q, (snapshot) => {
      const msgs = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
      setMessages(msgs);
    }, (error) => {
      handleFirestoreError(error, OperationType.LIST, `chats/${chatId}/messages`);
    });

    return () => unsubscribe();
  }, [user, selectedUser]);

  // Global listener for message notifications
  useEffect(() => {
    if (!user) return;
    
    const q = query(
      collection(db, 'chats'),
      where('participants', 'array-contains', user.uid)
    );
    
    const unsubscribe = onSnapshot(q, (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        if (change.type === 'added' || change.type === 'modified') {
          const data = change.doc.data();
          if (data.lastMessageSenderId && data.lastMessageSenderId !== user.uid) {
            const msgTime = data.lastMessageTime?.toMillis?.() || 0;
            const notifKey = `msg_${change.doc.id}_${msgTime}`;
            
            if (!notifiedIds.current.has(notifKey)) {
              notifiedIds.current.add(notifKey);
              
              // Only notify if recent (last 10 seconds) to avoid spam on load
              if (Date.now() - msgTime < 10000) {
                const otherUserId = data.participants.find((id: string) => id !== user.uid);
                const isCurrentlyViewing = selectedUser?.uid === otherUserId && document.visibilityState === 'visible';
                
                if (!isCurrentlyViewing) {
                  const sender = users.find(u => u.uid === data.lastMessageSenderId);
                  const senderName = currentUserData?.nicknames?.[data.lastMessageSenderId] || sender?.displayName || 'Someone';
                  showNotification(`New message from ${senderName}`, data.lastMessage);
                }
              }
            }
          }
        }
      });
    });
    
    return () => unsubscribe();
  }, [user, selectedUser, users, currentUserData]);

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMessage.trim() || !user || !selectedUser) return;

    const chatId = [user.uid, selectedUser.uid].sort().join('_');
    const messageText = newMessage.trim();
    setNewMessage('');

    try {
      const messageRef = doc(collection(db, 'chats', chatId, 'messages'));
      await setDoc(messageRef, {
        type: 'text',
        text: messageText,
        senderId: user.uid,
        receiverId: selectedUser.uid,
        timestamp: serverTimestamp(),
      });

      // Update last message in chat metadata
      await setDoc(doc(db, 'chats', chatId), {
        lastMessage: messageText,
        lastMessageTime: serverTimestamp(),
        participants: [user.uid, selectedUser.uid],
        lastMessageSenderId: user.uid
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `chats/${chatId}`);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64AudioMessage = reader.result as string;
          await sendAudioMessage(base64AudioMessage);
        };
        stream.getTracks().forEach(track => track.stop());
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (error) {
      console.error("Error accessing microphone:", error);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const sendAudioMessage = async (base64Audio: string) => {
    if (!user || !selectedUser) return;
    const chatId = [user.uid, selectedUser.uid].sort().join('_');
    
    try {
      const messageRef = doc(collection(db, 'chats', chatId, 'messages'));
      await setDoc(messageRef, {
        type: 'audio',
        audioUrl: base64Audio,
        senderId: user.uid,
        receiverId: selectedUser.uid,
        timestamp: serverTimestamp(),
      });

      await setDoc(doc(db, 'chats', chatId), {
        lastMessage: '🎵 Voice message',
        lastMessageTime: serverTimestamp(),
        participants: [user.uid, selectedUser.uid],
        lastMessageSenderId: user.uid
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `chats/${chatId}`);
    }
  };

  const sendGifMessage = async (gifUrl: string) => {
    if (!user || !selectedUser) return;
    const chatId = [user.uid, selectedUser.uid].sort().join('_');
    
    try {
      const messageRef = doc(collection(db, 'chats', chatId, 'messages'));
      await setDoc(messageRef, {
        type: 'gif',
        gifUrl: gifUrl,
        senderId: user.uid,
        receiverId: selectedUser.uid,
        timestamp: serverTimestamp(),
      });

      await setDoc(doc(db, 'chats', chatId), {
        lastMessage: 'GIF',
        lastMessageTime: serverTimestamp(),
        participants: [user.uid, selectedUser.uid],
        lastMessageSenderId: user.uid
      }, { merge: true });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `chats/${chatId}`);
    }
  };

  const initiateCall = async (isVideo: boolean, targetUser: any = selectedUser) => {
    if (!user || !targetUser) return;

    try {
      const callDoc = doc(collection(db, 'calls'));
      await setDoc(callDoc, {
        callerId: user.uid,
        receiverId: targetUser.uid,
        status: 'initiating', // Will be updated to 'calling' by CallScreen
        isVideo,
        timestamp: serverTimestamp()
      });

      const chatId = [user.uid, targetUser.uid].sort().join('_');
      await addDoc(collection(db, 'chats', chatId, 'messages'), {
        type: 'call',
        text: isVideo ? '📹 Video call started' : '📞 Audio call started',
        senderId: user.uid,
        receiverId: targetUser.uid,
        timestamp: serverTimestamp(),
      });

      await setDoc(doc(db, 'chats', chatId), {
        lastMessage: isVideo ? '📹 Video call' : '📞 Audio call',
        lastMessageTime: serverTimestamp(),
        participants: [user.uid, targetUser.uid],
        lastMessageSenderId: user.uid
      }, { merge: true });

      setActiveCall({
        id: callDoc.id,
        isIncoming: false,
        callerName: getDisplayName(targetUser),
        callerPhoto: targetUser.photoURL,
        isVideo,
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'calls');
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !user || !selectedUser) return;
    
    try {
      const transferRef = doc(collection(db, 'file_transfers'));
      const transferData = {
        senderId: user.uid,
        receiverId: selectedUser.uid,
        fileName: file.name,
        fileSize: file.size,
        fileType: file.type || 'application/octet-stream',
        status: 'initializing',
        timestamp: serverTimestamp()
      };
      
      await setDoc(transferRef, transferData);
      
      setActiveTransfer({
        id: transferRef.id,
        isSender: true,
        file: file,
        data: transferData
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, 'file_transfers');
    }
    
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleSignOut = () => {
    signOut(auth);
  };

  const filteredUsers = users.filter(u => 
    u.displayName?.toLowerCase().includes(searchQuery.toLowerCase()) || 
    u.email?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const activeSelectedUser = selectedUser ? users.find(u => u.uid === selectedUser.uid) || selectedUser : null;

  return (
    <div className="h-[100dvh] w-full flex md:p-4 md:gap-4 overflow-hidden relative bg-zinc-950">
      {activeCall && user && (
        <CallScreen
          isIncoming={activeCall.isIncoming}
          callerName={activeCall.callerName}
          callerPhoto={activeCall.callerPhoto}
          callId={activeCall.id}
          isVideo={activeCall.isVideo}
          currentUserId={user.uid}
          onEndCall={() => setActiveCall(null)}
        />
      )}

      {activeTransfer && user && (
        <FileTransfer
          transferId={activeTransfer.id}
          isSender={activeTransfer.isSender}
          file={activeTransfer.file}
          transferData={activeTransfer.data}
          currentUserId={user.uid}
          onClose={() => setActiveTransfer(null)}
        />
      )}

      {/* Sidebar */}
      <div className={cn(
        "w-full md:w-80 glass-panel rounded-none md:rounded-[2.5rem] flex flex-col overflow-hidden shrink-0 border-0 md:border border-white/10 bg-white/5 backdrop-blur-3xl shadow-[0_0_40px_rgba(0,0,0,0.3)] z-10",
        selectedUser ? "hidden md:flex" : "flex"
      )}>
        {/* Header */}
        <div className="p-4 border-b border-white/10 flex items-center justify-between bg-black/20 backdrop-blur-md">
          <div className="flex items-center gap-3">
            <img 
              src={user?.photoURL || ''} 
              alt="Profile" 
              className="w-10 h-10 rounded-full border border-glass-border object-cover"
            />
            <div>
              <h2 className="font-medium text-sm">{user?.displayName}</h2>
              <p className="text-xs text-green-400">Online</p>
            </div>
          </div>
          <div className="flex items-center gap-1">
            <button 
              onClick={toggleFullscreen}
              className="p-2 rounded-full transition-colors text-zinc-400 hover:text-white hover:bg-white/10"
              title={isFullscreen ? "Exit Fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
            </button>
            <button 
              onClick={requestNotificationPermission}
              className={cn(
                "p-2 rounded-full transition-colors",
                notifPermission === 'granted' ? "text-blue-400 hover:bg-white/10" : "text-zinc-400 hover:text-white hover:bg-white/10"
              )}
              title={notifPermission === 'granted' ? "Notifications Enabled" : "Enable Notifications"}
            >
              {notifPermission === 'granted' ? <Bell className="w-5 h-5" /> : <BellOff className="w-5 h-5" />}
            </button>
            <button 
              onClick={handleSignOut}
              className="p-2 hover:bg-white/10 rounded-full transition-colors text-zinc-400 hover:text-white"
              title="Sign Out"
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="p-4 flex flex-col gap-3">
          <div className="flex justify-between items-center text-xs text-zinc-400 font-medium uppercase tracking-wider">
            <span>Contacts</span>
            <span className="bg-white/10 px-2 py-0.5 rounded-full">{users.length + 1} Total</span>
          </div>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
            <input 
              type="text" 
              placeholder="Search users..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="glass-input w-full pl-9 pr-4 py-2 rounded-xl text-sm"
            />
          </div>
        </div>

        {/* User List */}
        <div className="flex-1 overflow-y-auto scrollbar-hide">
          {filteredUsers.map(u => (
            <div 
              key={u.uid}
              onClick={() => setSelectedUser(u)}
              className={cn(
                "p-4 flex items-center gap-3 cursor-pointer transition-colors hover:bg-white/5 border-b border-glass-border/50 group",
                selectedUser?.uid === u.uid && "bg-white/10"
              )}
            >
              <div className="relative">
                <img 
                  src={u.photoURL} 
                  alt={u.displayName} 
                  className="w-12 h-12 rounded-full object-cover border border-glass-border"
                />
                <div className={cn(
                  "absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-[#1a1a24]",
                  checkIsOnline(u) ? "bg-green-500" : "bg-zinc-500"
                )}></div>
              </div>
              <div className="flex-1 min-w-0">
                <h3 className="font-medium text-sm truncate">{getDisplayName(u)}</h3>
                <p className="text-xs truncate">
                  <span className={checkIsOnline(u) ? 'text-green-400' : 'text-zinc-500'}>
                    {checkIsOnline(u) ? 'Online' : 'Offline'}
                  </span>
                </p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <button 
                  onClick={(e) => { e.stopPropagation(); initiateCall(false, u); }} 
                  className="p-2 hover:bg-white/10 rounded-full text-zinc-400 hover:text-white transition-colors"
                  title="Audio Call"
                >
                  <Phone className="w-4 h-4" />
                </button>
                <button 
                  onClick={(e) => { e.stopPropagation(); initiateCall(true, u); }} 
                  className="p-2 hover:bg-white/10 rounded-full text-zinc-400 hover:text-white transition-colors"
                  title="Video Call"
                >
                  <Video className="w-4 h-4" />
                </button>
              </div>
            </div>
          ))}
          {filteredUsers.length === 0 && (
            <div className="p-8 text-center text-zinc-500 text-sm">
              No users found
            </div>
          )}
        </div>
      </div>

      {/* Main Chat Area */}
      <div className={cn(
        "flex-1 glass-panel rounded-none md:rounded-[2.5rem] flex flex-col overflow-hidden relative border-0 md:border border-white/10 bg-white/5 backdrop-blur-3xl shadow-[0_0_40px_rgba(0,0,0,0.3)] z-10",
        !selectedUser ? "hidden md:flex" : "flex"
      )}>
        <AnimatePresence mode="wait">
          {activeSelectedUser ? (
            <motion.div 
              key={activeSelectedUser.uid}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.2 }}
              className="flex-1 flex flex-col h-full"
            >
              {/* Chat Header */}
            <div className="p-3 md:p-4 border-b border-white/10 flex items-center justify-between bg-black/20 backdrop-blur-md z-10">
              <div className="flex items-center gap-2 md:gap-3">
                <button 
                  onClick={() => setSelectedUser(null)}
                  className="md:hidden p-2 -ml-2 hover:bg-white/10 rounded-full text-zinc-400 hover:text-white transition-colors"
                >
                  <ChevronLeft className="w-6 h-6" />
                </button>
                <img 
                  src={activeSelectedUser.photoURL} 
                  alt={activeSelectedUser.displayName} 
                  className="w-10 h-10 rounded-full object-cover border border-glass-border"
                />
                <div>
                  <h2 className="font-medium">{getDisplayName(activeSelectedUser)}</h2>
                  <p className="text-xs">
                    <span className={checkIsOnline(activeSelectedUser) ? 'text-green-400' : 'text-zinc-500'}>
                      {checkIsOnline(activeSelectedUser) ? 'Online' : 'Offline'}
                    </span>
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button 
                  onClick={() => initiateCall(false)}
                  className="p-2.5 glass-button rounded-full text-zinc-300 hover:text-white"
                >
                  <Phone className="w-5 h-5" />
                </button>
                <button 
                  onClick={() => initiateCall(true)}
                  className="p-2.5 glass-button rounded-full text-zinc-300 hover:text-white"
                >
                  <Video className="w-5 h-5" />
                </button>
                <div className="relative">
                  <button 
                    onClick={() => setShowMenu(!showMenu)}
                    className="p-2.5 hover:bg-white/10 rounded-full transition-colors text-zinc-400 hover:text-white ml-2"
                  >
                    <MoreVertical className="w-5 h-5" />
                  </button>
                  {showMenu && (
                    <>
                      <div className="fixed inset-0 z-40" onClick={() => setShowMenu(false)}></div>
                      <div className="absolute right-0 mt-2 w-48 bg-zinc-900 border border-glass-border rounded-xl shadow-xl overflow-hidden z-50">
                        <button 
                          onClick={() => {
                            setShowMenu(false);
                            setEditNameInput(getDisplayName(activeSelectedUser));
                            setIsEditingName(true);
                          }}
                          className="w-full text-left px-4 py-3 text-sm text-white hover:bg-white/10 transition-colors"
                        >
                          Edit Name
                        </button>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
              <AnimatePresence initial={false}>
                {messages.map((msg, idx) => {
                  const isMe = msg.senderId === user?.uid;
                  const showAvatar = idx === messages.length - 1 || messages[idx + 1]?.senderId !== msg.senderId;
                  
                  return (
                    <motion.div 
                      key={msg.id} 
                      initial={{ opacity: 0, y: 10, scale: 0.95 }}
                      animate={{ opacity: 1, y: 0, scale: 1 }}
                      transition={{ duration: 0.2 }}
                      className={cn("flex gap-2 max-w-[85%] md:max-w-[75%]", isMe ? "self-end flex-row-reverse" : "self-start")}
                    >
                      {showAvatar ? (
                        <img 
                          src={isMe ? user?.photoURL : activeSelectedUser.photoURL} 
                          alt="Avatar" 
                          className="w-8 h-8 rounded-full object-cover mt-auto shrink-0"
                        />
                      ) : (
                        <div className="w-8 shrink-0"></div>
                      )}
                      <div className={cn(
                        "p-3 rounded-[1.25rem] relative group shadow-lg backdrop-blur-md",
                        isMe 
                          ? "bg-gradient-to-r from-blue-600 via-purple-600 to-blue-600 bg-[length:200%_auto] animate-gradient-x text-white rounded-br-sm border border-white/20 shadow-purple-500/20" 
                          : "bg-white/10 border border-white/10 text-zinc-100 rounded-bl-sm shadow-black/20"
                      )}>
                        {msg.type === 'audio' ? (
                          <audio controls src={msg.audioUrl} className="max-w-[200px] md:max-w-[250px] h-10" />
                        ) : msg.type === 'call' ? (
                          <div className="flex items-center gap-2">
                            {msg.text.includes('Video') ? <Video className="w-4 h-4" /> : <Phone className="w-4 h-4" />}
                            <p className="text-sm font-medium">{msg.text}</p>
                          </div>
                        ) : msg.type === 'file_transfer' ? (
                          <div className="flex items-center gap-2">
                            <Paperclip className="w-4 h-4" />
                            <p className="text-sm font-medium">{msg.text}</p>
                          </div>
                        ) : msg.type === 'gif' ? (
                          <img src={msg.gifUrl} alt="GIF" className="max-w-[200px] md:max-w-[250px] rounded-lg" />
                        ) : (
                          <p className="text-sm">{msg.text}</p>
                        )}
                        <span className="text-[10px] opacity-60 mt-1 block text-right">
                          {msg.timestamp ? format(msg.timestamp.toDate(), 'MMM d, yyyy • h:mm a') : '...'}
                        </span>
                      </div>
                    </motion.div>
                  );
                })}
              </AnimatePresence>
              {messages.length === 0 && (
                <div className="m-auto text-center text-zinc-500">
                  <div className="w-16 h-16 rounded-full bg-white/5 flex items-center justify-center mx-auto mb-4">
                    <UserIcon className="w-8 h-8 opacity-50" />
                  </div>
                  <p>Say hello to {getDisplayName(activeSelectedUser)}!</p>
                </div>
              )}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Area */}
            <div className="p-2 sm:p-4 bg-black/20 border-t border-white/10 backdrop-blur-md relative z-10">
              {showGifPicker && (
                <GifPicker 
                  onSelect={sendGifMessage} 
                  onClose={() => setShowGifPicker(false)} 
                />
              )}
              <form onSubmit={handleSendMessage} className="flex items-center gap-1 sm:gap-2">
                <input 
                  type="file" 
                  ref={fileInputRef} 
                  onChange={handleFileSelect} 
                  className="hidden" 
                />
                <button 
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="p-2 sm:p-3 rounded-full text-zinc-400 hover:text-white hover:bg-white/10 transition-colors shrink-0"
                  title="Send File Directly (P2P)"
                >
                  <Paperclip className="w-5 h-5" />
                </button>
                <button 
                  type="button"
                  onClick={() => setShowGifPicker(!showGifPicker)}
                  className={cn(
                    "p-2 sm:p-3 rounded-full transition-colors shrink-0",
                    showGifPicker ? "text-blue-400 bg-white/10" : "text-zinc-400 hover:text-white hover:bg-white/10"
                  )}
                  title="Send GIF"
                >
                  <Smile className="w-5 h-5" />
                </button>
                <input
                  type="text"
                  value={newMessage}
                  onChange={(e) => {
                    const val = e.target.value;
                    if (val.length > newMessage.length) {
                      playTypingSound();
                    }
                    setNewMessage(val);
                  }}
                  onFocus={() => setShowGifPicker(false)}
                  placeholder={isRecording ? "Recording..." : "Type a message..."}
                  disabled={isRecording}
                  className="glass-input flex-1 min-w-0 py-2 sm:py-3 px-3 sm:px-4 rounded-full text-sm disabled:opacity-50"
                />
                <button 
                  type="button"
                  onClick={isRecording ? stopRecording : startRecording}
                  className={cn(
                    "p-2 sm:p-3 rounded-full text-white transition-all hover:scale-105 active:scale-95 shrink-0",
                    isRecording ? "bg-red-500 animate-pulse" : "bg-zinc-800 hover:bg-zinc-700"
                  )}
                >
                  {isRecording ? <Square className="w-5 h-5" /> : <Mic className="w-5 h-5" />}
                </button>
                <button 
                  type="submit"
                  disabled={!newMessage.trim() || isRecording}
                  className="p-2 sm:p-3 bg-gradient-to-r from-blue-500 to-purple-500 rounded-full text-white disabled:opacity-50 transition-all hover:scale-105 active:scale-95 shrink-0"
                >
                  <Send className="w-5 h-5 ml-0.5" />
                </button>
              </form>
            </div>
          </motion.div>
        ) : (
          <motion.div 
            key="empty-state"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 flex flex-col items-center justify-center text-zinc-500"
          >
            <div className="w-24 h-24 rounded-full bg-white/5 flex items-center justify-center mb-6 border border-glass-border">
              <div className="w-16 h-16 rounded-full bg-gradient-to-tr from-blue-500/20 to-purple-500/20 flex items-center justify-center">
                <span className="text-3xl">✨</span>
              </div>
            </div>
            <h2 className="text-xl font-medium text-zinc-300 mb-2">Nova Plus</h2>
            <p className="max-w-xs text-center text-sm">Select a conversation from the sidebar to start chatting</p>
          </motion.div>
        )}
        </AnimatePresence>
      </div>

      {/* Edit Name Modal */}
      {isEditingName && activeSelectedUser && (
        <div className="fixed inset-0 z-[200] bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div 
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-zinc-900 border border-glass-border p-6 rounded-2xl max-w-sm w-full shadow-2xl"
          >
            <h3 className="text-lg font-medium text-white mb-4">Edit Name</h3>
            <input 
              type="text" 
              value={editNameInput}
              onChange={(e) => setEditNameInput(e.target.value)}
              className="w-full glass-input px-4 py-2 rounded-xl text-sm mb-6 text-white"
              placeholder="Enter new name"
              autoFocus
            />
            <div className="flex gap-3">
              <button 
                onClick={() => setIsEditingName(false)}
                className="flex-1 py-2 rounded-xl bg-zinc-800 text-white hover:bg-zinc-700 transition-colors"
              >
                Cancel
              </button>
              <button 
                onClick={async () => {
                  if (!user) return;
                  try {
                    await updateDoc(doc(db, 'users', user.uid), {
                      [`nicknames.${activeSelectedUser.uid}`]: editNameInput.trim() || activeSelectedUser.displayName
                    });
                    setIsEditingName(false);
                  } catch (e) {
                    console.error('Failed to update name', e);
                  }
                }}
                className="flex-1 py-2 rounded-xl bg-blue-600 text-white hover:bg-blue-500 transition-colors"
              >
                Save
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* In-App Toast Notifications */}
      <div className="fixed top-4 right-4 z-[300] flex flex-col gap-2 pointer-events-none">
        <AnimatePresence>
          {toasts.map(toast => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: -20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, scale: 0.9, transition: { duration: 0.2 } }}
              className="bg-zinc-900 border border-glass-border p-4 rounded-2xl shadow-2xl w-72 pointer-events-auto"
            >
              <h4 className="text-sm font-medium text-white mb-1">{toast.title}</h4>
              <p className="text-xs text-zinc-400 line-clamp-2">{toast.body}</p>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

