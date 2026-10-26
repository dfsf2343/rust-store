import { lazy, Suspense } from 'react';
import { BrowserRouter, MemoryRouter, Route, Routes } from 'react-router';
import { Layout } from './components/Layout';
import { DataProvider } from './data';
import { Account } from './pages/Account';
import { Admin } from './pages/Admin';
import { Checkout } from './pages/Checkout';
import { Home } from './pages/Home';
import { Faq, Rules } from './pages/Info';
import { Privacy, Refunds, Terms } from './pages/Legal';
import { NotFound } from './pages/NotFound';
import { Order } from './pages/Order';
import { KitPage, Store } from './pages/Store';

// The demo build runs inside an embedded preview, where only in-memory routing works.
const DEMO = import.meta.env.MODE === 'demo';
const Router = DEMO ? MemoryRouter : BrowserRouter;
const DemoLogin = DEMO ? lazy(() => import('./demo/DemoBar').then((m) => ({ default: m.DemoLogin }))) : null;
const DemoRefresh = DEMO ? lazy(() => import('./demo/DemoBar').then((m) => ({ default: m.DemoRefresh }))) : null;

export function App() {
  return (
    <DataProvider>
      <Router>
        <Routes>
          <Route element={<Layout />}>
            <Route index element={<Home />} />
            <Route path="store" element={<Store />} />
            <Route path="store/:kitId" element={<KitPage />} />
            <Route path="checkout/:kitId" element={<Checkout />} />
            <Route path="order/:orderId" element={<Order />} />
            <Route path="account" element={<Account />} />
            <Route path="rules" element={<Rules />} />
            <Route path="faq" element={<Faq />} />
            <Route path="terms" element={<Terms />} />
            <Route path="refunds" element={<Refunds />} />
            <Route path="privacy" element={<Privacy />} />
            <Route path="admin" element={<Admin />} />
            {DemoLogin && (
              <Route
                path="demo-login"
                element={
                  <Suspense>
                    <DemoLogin />
                  </Suspense>
                }
              />
            )}
            {DemoRefresh && (
              <Route
                path="demo-refresh"
                element={
                  <Suspense>
                    <DemoRefresh />
                  </Suspense>
                }
              />
            )}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </Router>
    </DataProvider>
  );
}
