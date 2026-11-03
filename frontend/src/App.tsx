import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Layout, NotFound, PageView } from '@/components/Layout';
import { PAGES } from '@/pages/registry';

export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route element={<Layout />}>
          {PAGES.map((p) => (
            <Route key={p.id} path={p.path} element={<PageView page={p} />} />
          ))}
          {/* old bookmarks such as /agents.html */}
          {PAGES.map((p) => (
            <Route key={`${p.id}-html`} path={`/${p.id}.html`} element={<Navigate to={p.path} replace />} />
          ))}
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
