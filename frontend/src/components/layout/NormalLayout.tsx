import { Outlet, useSearchParams } from 'react-router-dom';

import { Navbar } from '@/components/layout/Navbar';
import { StatusBar } from '@/components/layout/StatusBar';

export function NormalLayout() {
  const [searchParams] = useSearchParams();
  const view = searchParams.get('view');
  const shouldHideNavbar = view === 'preview' || view === 'diffs';

  return (
    <div className="flex flex-col h-screen">
      {!shouldHideNavbar && <Navbar />}
      <div className="flex-1 overflow-auto">
        <Outlet />
      </div>
      <StatusBar />
    </div>
  );
}
