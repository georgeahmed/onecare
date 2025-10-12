import { Navigate, Route, Routes } from 'react-router-dom';
import IntakePage from './pages/Intake';

const App = () => {
  return (
    <Routes>
      <Route path="/intake" element={<IntakePage />} />
      <Route path="*" element={<Navigate to="/intake" replace />} />
    </Routes>
  );
};

export default App;
