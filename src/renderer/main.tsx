import { createRoot } from 'react-dom/client';
import { App } from './App';
import { TrayPanel } from './components/TrayPanel';
import { CaptureBox } from './components/CaptureBox';
import './styles.css';

// 빠른 메모 창은 같은 화면 묶음을 #capture 로 연다: 입력 상자만 그린다.
createRoot(document.getElementById('root')!).render(window.location.hash === '#capture' ? <CaptureBox /> : window.location.hash === '#tray' ? <TrayPanel /> : <App />);
