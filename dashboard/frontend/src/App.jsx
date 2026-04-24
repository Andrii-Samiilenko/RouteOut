import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Coordinator from '@/pages/Coordinator';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/coordinator" element={<Coordinator />} />
        <Route path="*" element={<Navigate to="/coordinator" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
