import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import {
  AccountError,
  accountApi,
  openExternal,
  resolveCurrentHostIdentity,
  type DeviceLogin,
} from '@/features/model-router';

export function useAccountDeviceLogin(options: {
  isSignedIn: boolean;
  refresh: () => Promise<unknown>;
}) {
  const { isSignedIn, refresh } = options;
  const { t } = useTranslation(['settings', 'common']);

  const [loginState, setLoginState] = useState<{
    login: DeviceLogin;
    expiresAt: number;
  } | null>(null);
  const [startingLogin, setStartingLogin] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);

  const describeError = useCallback(
    (cause: unknown) => {
      const code = cause instanceof AccountError ? cause.code : '';
      if (code === 'network')
        return t('settings:agents.modelRouterErrorNetwork');
      if (code === 'expired' || code === 'invalid') {
        return t('settings:agents.modelRouterErrorExpired');
      }
      if (code === 'denied') return t('settings:agents.modelRouterErrorDenied');
      if (code === 'signed_out') {
        return t('settings:agents.modelRouterErrorSignedOut');
      }
      if (!(cause instanceof AccountError) && cause instanceof Error) {
        return cause.message;
      }
      return t('settings:agents.modelRouterErrorFailed');
    },
    [t]
  );

  useEffect(() => {
    if (isSignedIn) {
      setLoginState(null);
      setAuthError(null);
    }
  }, [isSignedIn]);

  useEffect(() => {
    if (!loginState) return;
    let stopped = false;
    const timer = window.setInterval(async () => {
      if (Date.now() >= loginState.expiresAt) {
        window.clearInterval(timer);
        setLoginState(null);
        setAuthError(t('settings:agents.modelRouterErrorExpired'));
        return;
      }
      try {
        const approved = await accountApi.pollLogin(loginState.login);
        if (stopped || !approved) return;
        window.clearInterval(timer);
        setLoginState(null);
        setAuthError(null);
        await refresh();
      } catch (cause) {
        if (stopped) return;
        if (cause instanceof AccountError && cause.code === 'network') return;
        window.clearInterval(timer);
        setLoginState(null);
        setAuthError(describeError(cause));
      }
    }, loginState.login.interval * 1000);

    return () => {
      stopped = true;
      window.clearInterval(timer);
    };
  }, [describeError, loginState, refresh, t]);

  const startLogin = useCallback(async () => {
    setStartingLogin(true);
    setAuthError(null);
    try {
      const identity = await resolveCurrentHostIdentity().catch(() => null);
      const next = await accountApi.startLogin(
        identity
          ? { deviceName: identity.hostName, hostId: identity.hostId }
          : undefined
      );
      setLoginState({
        login: next,
        expiresAt: Date.now() + next.expiresIn * 1000,
      });
      await openExternal(next.verifyUrl);
    } catch (cause) {
      setAuthError(describeError(cause));
    } finally {
      setStartingLogin(false);
    }
  }, [describeError]);

  const cancelLogin = useCallback(() => {
    setLoginState(null);
  }, []);

  const reopenVerifyUrl = useCallback(() => {
    if (!loginState) return;
    void openExternal(loginState.login.verifyUrl);
  }, [loginState]);

  return {
    loginState,
    startingLogin,
    authError,
    startLogin,
    cancelLogin,
    reopenVerifyUrl,
  };
}
