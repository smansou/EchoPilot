import { createRoot } from 'react-dom/client';
import { DesktopApp } from './DesktopApp';
import './desktop.css';
document.documentElement.dataset.surface=new URLSearchParams(location.search).get('view')||'dashboard';
const root=document.getElementById('root');
if(!root)throw Error('Renderer root missing');
createRoot(root).render(<DesktopApp/>);
