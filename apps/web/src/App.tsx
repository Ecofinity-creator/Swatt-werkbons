import type { UserRole } from '@swatt/shared-types';
import { roleAtLeast } from '@swatt/shared-types';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { TeamleaderSettingsPage } from './pages/TeamleaderSettingsPage';

function LoadingScreen() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-swatt-black text-neutral-400">
      Laden...
    </div>
  );
}

/** `minimumRole` optioneel: zonder wordt enkel op een geldige sessie gecontroleerd (zoals voorheen). */
function RequireAuth({
  children,
  minimumRole,
}: {
  children: React.ReactElement;
  minimumRole?: UserRole;
}) {
  const { user, isLoading } = useAuth();
  if (isLoading) return <LoadingScreen />;
  if (!user) return <Navigate to="/login" replace />;
  if (minimumRole && !roleAtLeast(user.role, minimumRole)) return <Navigate to="/" replace />;
  return children;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <RequireAuth>
            <HomePage />
          </RequireAuth>
        }
      />
      <Route
        path="/instellingen/teamleader"
        element={
          <RequireAuth minimumRole="ADMIN">
            <TeamleaderSettingsPage />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
