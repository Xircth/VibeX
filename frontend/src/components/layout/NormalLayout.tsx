import { Outlet, useSearchParams, useLocation } from 'react-router-dom';

import { Navbar } from '@/components/layout/Navbar';

export function NormalLayout() {
  const [searchParams] = useSearchParams();
  const location = useLocation();
  const view = searchParams.get('view');
  const isWelcomePage =
    location.pathname === '/' || location.pathname === '/local-projects';
  const shouldHideNavbar =
    view === 'preview' || view === 'diffs' || isWelcomePage;

  return (
    <>
      <div className="flex flex-col h-screen">
        {!shouldHideNavbar && <Navbar />}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </div>
    </>
  );
}
