'use client';

import React, { createContext, useCallback, useContext, useState } from 'react';

interface ToastMessage {
  id: number;
  text: string;
}

interface ToastCtx {
  showToast: (text: string) => void;
}

const Context = createContext<ToastCtx>({ showToast: () => {} });

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastMessage[]>([]);

  const showToast = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, text }]);
    setTimeout(() => {
      setItems((prev) => prev.filter((t) => t.id !== id));
    }, 3600);
  }, []);

  return (
    <Context.Provider value={{ showToast }}>
      {children}
      <div className="toast-stack" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className="toast-pill">
            {t.text}
          </div>
        ))}
      </div>
    </Context.Provider>
  );
}

export function useToast() {
  return useContext(Context);
}
