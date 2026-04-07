import React, { Component, ErrorInfo, ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false,
    error: null
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Uncaught error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      let errorMessage = this.state.error?.message || 'Unknown error';
      let isFirestoreError = false;
      
      try {
        const parsed = JSON.parse(errorMessage);
        if (parsed.error && parsed.operationType) {
          isFirestoreError = true;
          errorMessage = parsed.error;
        }
      } catch (e) {}

      return (
        <div className="min-h-screen flex items-center justify-center p-4 bg-zinc-950 text-zinc-100">
          <div className="glass-panel max-w-lg w-full p-8 rounded-3xl border border-red-500/30 bg-red-500/10">
            <h1 className="text-2xl font-bold text-red-400 mb-4">Firebase Configuration Error</h1>
            <p className="text-zinc-300 mb-4">
              {isFirestoreError 
                ? "A database error occurred. This usually means your Firestore Database is not created, or your Security Rules are denying access."
                : "An unexpected error occurred in the application."}
            </p>
            <div className="bg-black/50 p-4 rounded-xl overflow-auto text-sm font-mono text-red-300 mb-6">
              {errorMessage}
            </div>
            <div className="text-sm text-zinc-400 mb-6 space-y-2">
              <p><strong>To fix this:</strong></p>
              <ol className="list-decimal pl-5 space-y-1">
                <li>Go to the <a href="https://console.firebase.google.com/" target="_blank" rel="noreferrer" className="text-blue-400 hover:underline">Firebase Console</a></li>
                <li>Open your project</li>
                <li>Go to <strong>Firestore Database</strong> and click <strong>Create Database</strong></li>
                <li>Go to the <strong>Rules</strong> tab and set them to allow read/write (e.g., <code className="bg-black/30 px-1 rounded">allow read, write: if request.auth != null;</code> for testing)</li>
                <li>Go to <strong>Authentication</strong> and enable Email/Password and Google providers.</li>
              </ol>
            </div>
            <button
              onClick={() => window.location.reload()}
              className="bg-red-500 hover:bg-red-600 text-white px-6 py-2 rounded-xl transition-colors w-full"
            >
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return (this as any).props.children;
  }
}
