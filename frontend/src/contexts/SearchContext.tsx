import {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  ReactNode,
} from 'react';
import { useLocation, useParams } from 'react-router-dom';

interface SearchState {
  query: string;
  setQuery: (query: string) => void;
  active: boolean;
  clear: () => void;
  focusInput: () => void;
  registerInputRef: (ref: HTMLInputElement | null) => void;
}

const SearchContext = createContext<SearchState | null>(null);

interface SearchProviderProps {
  children: ReactNode;
}

export function SearchProvider({ children }: SearchProviderProps) {
  const [query, setQuery] = useState('');
  const location = useLocation();
  const { projectId } = useParams<{ projectId: string }>();
  const inputRef = useRef<HTMLInputElement | null>(null);

  const isProjectWorkspaceRoute = /^\/local-projects\/[^/]+\/(?:sessions|workspaces)/.test(
    location.pathname
  );

  useEffect(() => {
    if (!isProjectWorkspaceRoute && query !== '') {
      setQuery('');
    }
  }, [isProjectWorkspaceRoute, query]);

  // Clear search when project changes
  useEffect(() => {
    setQuery('');
  }, [projectId]);

  const clear = () => setQuery('');

  const focusInput = () => {
    if (inputRef.current && isProjectWorkspaceRoute) {
      inputRef.current.focus();
    }
  };

  const registerInputRef = useCallback((ref: HTMLInputElement | null) => {
    inputRef.current = ref;
  }, []);

  const value: SearchState = {
    query,
    setQuery,
    active: isProjectWorkspaceRoute,
    clear,
    focusInput,
    registerInputRef,
  };

  return (
    <SearchContext.Provider value={value}>{children}</SearchContext.Provider>
  );
}

export function useSearch(): SearchState {
  const context = useContext(SearchContext);
  if (!context) {
    throw new Error('useSearch must be used within a SearchProvider');
  }
  return context;
}
