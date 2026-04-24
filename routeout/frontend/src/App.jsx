import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import Coordinator from '@/pages/Coordinator';
import Citizen from '@/pages/Citizen';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/coordinator" element={<Coordinator />} />
        <Route path="/citizen" element={<Citizen />} />
        <Route path="*" element={<Navigate to="/coordinator" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
