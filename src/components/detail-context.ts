import { createContext, useContext } from 'react';

/**
 * Display detail for long series. `auto` thins series above FULL_DETAIL_LIMIT points per pixel column;
 * `all` draws every epoch. Only drawing is affected: statistics, events and exports always use every epoch.
 */
export type Detail = 'auto' | 'all';
export const DetailContext = createContext<Detail>('auto');
export const useDetail = () => useContext(DetailContext);
