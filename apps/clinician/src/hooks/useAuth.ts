import { useContext } from 'react';
import { AuthContextInternal } from '../lib/auth';

export const useAuth = () => {
  const context = useContext(AuthContextInternal);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export default useAuth;
