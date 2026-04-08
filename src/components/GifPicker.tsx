import React, { useState, useEffect } from 'react';
import { Search } from 'lucide-react';

interface GifPickerProps {
  onSelect: (url: string) => void;
  onClose: () => void;
}

export default function GifPicker({ onSelect, onClose }: GifPickerProps) {
  const [query, setQuery] = useState('');
  const [gifs, setGifs] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchGifs = async () => {
      setLoading(true);
      // Using Tenor V1 public API key
      const endpoint = query 
        ? `https://g.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=LIVDSRZULELA&limit=20`
        : `https://g.tenor.com/v1/trending?key=LIVDSRZULELA&limit=20`;
      try {
        const res = await fetch(endpoint);
        const data = await res.json();
        setGifs(data.results || []);
      } catch (e) {
        console.error("Failed to fetch GIFs", e);
      } finally {
        setLoading(false);
      }
    };
    
    const timeout = setTimeout(fetchGifs, 500);
    return () => clearTimeout(timeout);
  }, [query]);

  return (
    <div className="absolute bottom-full mb-2 left-0 md:left-4 w-72 h-96 bg-zinc-900 border border-glass-border rounded-2xl shadow-2xl flex flex-col overflow-hidden z-50">
      <div className="p-3 border-b border-glass-border relative">
        <Search className="absolute left-5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-400" />
        <input 
          type="text" 
          placeholder="Search Tenor GIFs..." 
          value={query}
          onChange={e => setQuery(e.target.value)}
          className="w-full bg-black/20 rounded-xl pl-9 pr-3 py-2 text-sm text-white outline-none border border-glass-border focus:border-blue-500/50 transition-colors"
          autoFocus
        />
      </div>
      <div className="flex-1 overflow-y-auto p-2 grid grid-cols-2 gap-2 scrollbar-hide">
        {loading && gifs.length === 0 ? (
          <div className="col-span-2 flex justify-center items-center h-32 text-zinc-500 text-sm">Loading...</div>
        ) : (
          gifs.map(gif => (
            <img 
              key={gif.id} 
              src={gif.media[0].tinygif.url} 
              alt="gif" 
              className="w-full h-24 object-cover rounded-lg cursor-pointer hover:opacity-80 transition-opacity bg-white/5"
              onClick={() => {
                onSelect(gif.media[0].gif.url);
                onClose();
              }}
            />
          ))
        )}
      </div>
    </div>
  );
}
