import { useMemo } from 'react';
import usePrefersReducedMotion from '../../hooks/usePrefersReducedMotion';

const COLORS = ['#38bdf8', '#0ea5e9', '#facc15', '#f97316', '#22c55e'];

const generatePieces = (count: number) =>
  Array.from({ length: count }, (_, index) => {
    const color = COLORS[index % COLORS.length];
    const delay = Math.random() * 0.6;
    const duration = 1.2 + Math.random() * 0.6;
    const horizontal = Math.random() * 100;
    const rotation = Math.random() * 360;
    return { color, delay, duration, horizontal, rotation, id: index };
  });

const ConfettiBurst = () => {
  const prefersReducedMotion = usePrefersReducedMotion();
  const pieces = useMemo(() => generatePieces(14), []);

  if (prefersReducedMotion) {
    return null;
  }

  return (
    <div className="confetti-burst" aria-hidden="true">
      {pieces.map((piece) => (
        <span
          key={piece.id}
          className="confetti-burst__piece"
          style={{
            ['--delay' as string]: `${piece.delay}s`,
            ['--duration' as string]: `${piece.duration}s`,
            ['--horizontal' as string]: `${piece.horizontal}%`,
            ['--rotation' as string]: `${piece.rotation}deg`,
            backgroundColor: piece.color
          }}
        />
      ))}
    </div>
  );
};

export default ConfettiBurst;
