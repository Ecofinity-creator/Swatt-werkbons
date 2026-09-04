import type { UserRole } from '@swatt/shared-types';
import { roleAtLeast } from '@swatt/shared-types';
import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth/AuthContext';
import { AppAccessPage } from './pages/AppAccessPage';
import { EmployeeProjectsPage } from './pages/EmployeeProjectsPage';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { ProjectTimerPage } from './pages/ProjectTimerPage';
import { SetPasswordPage } from './pages/SetPasswordPage';
import { TeamleaderSettingsPage } from './pages/TeamleaderSettingsPage';
import { WorkOrderReviewPage } from './pages/WorkOrderReviewPage';
import { CompanySettingsPage } from './pages/admin/CompanySettingsPage';
import { HoursExportPage } from './pages/admin/HoursExportPage';
import { PayrollPage } from './pages/admin/PayrollPage';
import { InvoicingPage } from './pages/admin/InvoicingPage';
import { ProjectMilestonesPage } from './pages/admin/ProjectMilestonesPage';
import { SyncIssuesPage } from './pages/admin/SyncIssuesPage';
import { AuditLogPage } from './pages/admin/AuditLogPage';
import { WorkOrdersOverviewPage } from './pages/admin/WorkOrdersOverviewPage';
import { MyWorkOrdersPage } from './pages/MyWorkOrdersPage';
import { UserDetailPage } from './pages/admin/UserDetailPage';
import { UsersPage } from './pages/admin/UsersPage';

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
      <Route path="/wachtwoord-vergeten" element={<ForgotPasswordPage />} />
      <Route path="/wachtwoord-instellen" element={<SetPasswordPage />} />
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
      <Route
        path="/instellingen/bedrijf"
        element={
          <RequireAuth minimumRole="ADMIN">
            <CompanySettingsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/mijn-projecten"
        element={
          <RequireAuth>
            <EmployeeProjectsPage />
          </RequireAuth>
        }
      />
      <Route
        path="/projecten/:projectId"
        element={
          <RequireAuth>
            <ProjectTimerPage />
          </RequireAuth>
        }
      />
      <Route
        path="/werkbonnen/:workOrderId"
        element={
          <RequireAuth>
            <WorkOrderReviewPage />
          </RequireAuth>
        }
      />
      <Route
        path="/app-toegang"
        element={
          <RequireAuth>
            <AppAccessPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/medewerkers"
        element={
          <RequireAuth minimumRole="SUPERVISOR">
            <UsersPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/medewerkers/:userId"
        element={
          <RequireAuth minimumRole="SUPERVISOR">
            <UserDetailPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/projecten"
        element={
          <RequireAuth minimumRole="SUPERVISOR">
            <ProjectMilestonesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/sync-fouten"
        element={
          <RequireAuth minimumRole="SUPERVISOR">
            <SyncIssuesPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/auditlog"
        element={
          <RequireAuth minimumRole="ADMIN">
            <AuditLogPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/werkbonnen"
        element={
          <RequireAuth minimumRole="SUPERVISOR">
            <WorkOrdersOverviewPage />
          </RequireAuth>
        }
      />
      <Route
        path="/mijn-werkbonnen"
        element={
          <RequireAuth>
            <MyWorkOrdersPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/facturatie"
        element={
          <RequireAuth minimumRole="ADMIN">
            <InvoicingPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/uren-export"
        element={
          <RequireAuth minimumRole="ADMIN">
            <HoursExportPage />
          </RequireAuth>
        }
      />
      <Route
        path="/backoffice/personeelsuitbetaling"
        element={
          <RequireAuth minimumRole="ADMIN">
            <PayrollPage />
          </RequireAuth>
        }
      />
    </Routes>
  );
}
