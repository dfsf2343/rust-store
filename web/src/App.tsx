import { BrowserRouter, Route, Routes } from 'react-router';
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

export function App() {
  return (
    <DataProvider>
      <BrowserRouter>
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
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </DataProvider>
  );
}
