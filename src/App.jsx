import { BrowserRouter, Routes, Route, Link } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import ProtectedRoute from './components/ProtectedRoute';
import ErrorBoundary from './components/ErrorBoundary';
import Layout from './components/Layout';
import NotifyHost from './components/NotifyHost';
import Login from './pages/Login';
import Signup from './pages/Signup';
import Home from './pages/Home';
import Announcements from './pages/Announcements';
import Schedule from './pages/Schedule';
import ShiftBoard from './pages/ShiftBoard';
import Chat from './pages/Chat';
import Admin from './pages/Admin';
import SuperAdmin from './pages/SuperAdmin';
import NotificationPreferences from './pages/NotificationPreferences';
import PlatformRevenue from './pages/PlatformRevenue';
import PlatformChat from './pages/PlatformChat';

function NotFound() {
  return (
    <div className="flex h-screen items-center justify-center bg-gray-50 px-4">
      <div className="mx-auto max-w-md rounded-xl bg-white p-8 shadow-sm text-center">
        <p className="text-6xl mb-2">🤔</p>
        <h1 className="text-2xl font-bold text-gray-900 mb-2">Page not found</h1>
        <p className="text-sm text-gray-500 mb-4">The page you're looking for doesn't exist.</p>
        <Link to="/" className="inline-block rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700">
          Back to Home
        </Link>
      </div>
    </div>
  );
}

function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/signup" element={<Signup />} />
      <Route path="/" element={<ProtectedRoute><Layout><Home /></Layout></ProtectedRoute>} />
      <Route path="/announcements" element={<ProtectedRoute><Layout><Announcements /></Layout></ProtectedRoute>} />
      <Route path="/schedule" element={<ProtectedRoute><Layout><Schedule /></Layout></ProtectedRoute>} />
      <Route path="/shift-board" element={<ProtectedRoute><Layout><ShiftBoard /></Layout></ProtectedRoute>} />
      <Route path="/chat" element={<ProtectedRoute><Layout><Chat /></Layout></ProtectedRoute>} />
      <Route path="/admin" element={<ProtectedRoute requireOwner><Layout><Admin /></Layout></ProtectedRoute>} />
      <Route path="/super-admin" element={<ProtectedRoute><Layout><SuperAdmin /></Layout></ProtectedRoute>} />
      <Route path="/platform-revenue" element={<ProtectedRoute><Layout><PlatformRevenue /></Layout></ProtectedRoute>} />
      <Route path="/platform-chat" element={<ProtectedRoute><Layout><PlatformChat /></Layout></ProtectedRoute>} />
      <Route path="/notifications" element={<ProtectedRoute><Layout><NotificationPreferences /></Layout></ProtectedRoute>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
          {/* Single global host for toasts + confirm dialogs. Mounted once
              here so any code path can call toast.success / confirmDialog
              from src/lib/notify.js without prop drilling. */}
          <NotifyHost />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
