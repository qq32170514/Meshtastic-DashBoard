import React from 'react';

const WebClientTab: React.FC = () => {
  return (
    <div className="w-full h-full flex flex-col bg-slate-900 overflow-hidden rounded-2xl border border-slate-800 shadow-2xl">
      <iframe
        src="https://client.meshtastic.org/"
        // 🚨 致命關鍵：允許嵌入網頁存取本地硬體 API
        allow="serial; bluetooth; usb"
        title="Meshtastic Web Client"
        // 計算高度：螢幕高度扣除頂部 Navbar 與 Tab 選單高度
        className="w-full h-[calc(100vh-160px)] border-0"
        loading="lazy"
      />
    </div>
  );
};

export default WebClientTab;