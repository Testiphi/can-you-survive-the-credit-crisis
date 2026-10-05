import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import { TipProvider } from './Tip.tsx';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root 未找到');

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {/* 统一管理悬浮提示，渲染到 document 层级，避免被 .col 的 overflow 裁切 */}
    <TipProvider>
      <App />
    </TipProvider>
  </React.StrictMode>,
);
