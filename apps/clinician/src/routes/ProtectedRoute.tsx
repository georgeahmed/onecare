import { Navigate, Outlet, useLocation } from 'react-router-dom';
import type { Role } from '../lib/auth';
import useAuth from '../hooks/useAuth';

interface ProtectedRouteProps {
  roles?: Role[];
  fallback?: JSX.Element;
}

const ProtectedRoute = ({ roles, fallback }: ProtectedRouteProps) => {
  const { status, session, hasRole } = useAuth();
  const location = useLocation();

  if (status === 'loading') {
    return fallback ?? <div role="status">Loading…</div>;
  }

  if (status !== 'authenticated' || !session) {
    return <Navigate to="/login" replace state={{ from: location }} />;
  }

  if (roles && roles.length > 0 && !hasRole(roles)) {
    return fallback ?? <div role="alert">Access denied.</div>;
  }

  return <Outlet />;
};

export default ProtectedRoute;
