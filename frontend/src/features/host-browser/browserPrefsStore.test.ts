import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_SETTINGS,
  evaluateHostRules,
  matchHostRule,
  normalizeBrowserSettings,
  parseHostRulePattern,
  resetBrowserPrefsForTests,
  resolveLinkOpenAction,
  validateHostRulePattern,
} from './browserPrefsStore';

describe('browserPrefsStore', () => {
  beforeEach(() => {
    resetBrowserPrefsForTests();
  });

  describe('parseHostRulePattern & validateHostRulePattern', () => {
    it('accepts exact hostnames, wildcard subdomains, ports, and schemes', () => {
      expect(validateHostRulePattern('example.com')).toBeNull();
      expect(validateHostRulePattern('*.corp.internal')).toBeNull();
      expect(validateHostRulePattern('localhost:3000')).toBeNull();
      expect(validateHostRulePattern('https://*.example.com:8443')).toBeNull();
      expect(validateHostRulePattern('[::1]:8080')).toBeNull();

      expect(parseHostRulePattern('https://*.Example.com:8443')).toEqual({
        scheme: 'https',
        host: 'example.com',
        wildcardSubdomain: true,
        port: 8443,
      });
    });

    it('rejects empty patterns, paths, invalid schemes, and invalid wildcards', () => {
      expect(validateHostRulePattern('   ')).toBe('empty');
      expect(validateHostRulePattern('https://example.com/login')).toBe('path');
      expect(validateHostRulePattern('ftp://example.com')).toBe('scheme');
      expect(validateHostRulePattern('example.com:99999')).toBe('port');
      expect(validateHostRulePattern('*example.com')).toBe('wildcard');
      expect(validateHostRulePattern('sub.*.example.com')).toBe('wildcard');
    });
  });

  describe('matchHostRule & evaluateHostRules', () => {
    it('prioritizes block rules over allow rules regardless of order', () => {
      const rules = [
        { pattern: '*.example.com', action: 'builtin' as const },
        { pattern: 'admin.example.com', action: 'block' as const },
      ];
      expect(evaluateHostRules(rules, 'https://app.example.com/dashboard')).toBe(
        'builtin'
      );
      expect(
        evaluateHostRules(rules, 'https://admin.example.com/dashboard')
      ).toBe('block');
    });

    it('matches wildcard subdomains and root domain', () => {
      expect(
        matchHostRule('*.corp.internal', 'https://sso.corp.internal/login')
      ).toBe(true);
      expect(
        matchHostRule('*.corp.internal', 'https://corp.internal/login')
      ).toBe(true);
      expect(
        matchHostRule('*.corp.internal', 'https://other.internal/login')
      ).toBe(false);
    });

    it('matches explicit ports and default scheme ports', () => {
      expect(matchHostRule('localhost:3000', 'http://localhost:3000/app')).toBe(
        true
      );
      expect(matchHostRule('localhost:3000', 'http://localhost:5173/app')).toBe(
        false
      );
      expect(
        matchHostRule('https://example.com:443', 'https://example.com/docs')
      ).toBe(true);
      expect(
        matchHostRule('https://example.com:443', 'http://example.com/docs')
      ).toBe(false);
    });
  });

  describe('normalizeBrowserSettings', () => {
    it('normalizes legacy siteRules string and partial fields', () => {
      const normalized = normalizeBrowserSettings({
        toolsEnabled: false,
        defaultGrant: 'read',
        evalApproval: 'ask',
        siteRules: '*.corp.internal=system\nmalicious.example.com=block',
      });
      expect(normalized.toolsEnabled).toBe(false);
      expect(normalized.defaultGrant).toBe('read');
      expect(normalized.evalApproval).toBe('ask');
      expect(normalized.hostRules).toEqual([
        { pattern: '*.corp.internal', action: 'system' },
        { pattern: 'malicious.example.com', action: 'block' },
      ]);
    });

    it('falls back to DEFAULT_BROWSER_SETTINGS for invalid values', () => {
      const normalized = normalizeBrowserSettings({
        defaultGrant: 'invalid',
        newTabProfile: '../bad-profile',
      });
      expect(normalized.defaultGrant).toBe(
        DEFAULT_BROWSER_SETTINGS.defaultGrant
      );
      expect(normalized.newTabProfile).toBe('default');
    });
  });

  describe('resolveLinkOpenAction', () => {
    it('resolves per-source link target and applies hostRules overrides', () => {
      const settings = normalizeBrowserSettings({
        defaultTarget: {
          ...DEFAULT_BROWSER_SETTINGS.defaultTarget,
          transcript: 'builtin',
          terminal: 'system',
          notification: 'ask',
        },
        hostRules: [
          { pattern: '*.github.com', action: 'system' },
          { pattern: 'blocked.example.com', action: 'block' },
        ],
      });

      expect(
        resolveLinkOpenAction('https://localhost:5173', 'transcript', settings)
      ).toBe('builtin');
      expect(
        resolveLinkOpenAction('https://localhost:5173', 'terminal', settings)
      ).toBe('system');
      expect(
        resolveLinkOpenAction(
          'https://localhost:5173',
          'notification',
          settings
        )
      ).toBe('ask');
      expect(
        resolveLinkOpenAction(
          'https://gist.github.com/test',
          'transcript',
          settings
        )
      ).toBe('system');
      expect(
        resolveLinkOpenAction(
          'https://blocked.example.com/phish',
          'transcript',
          settings
        )
      ).toBe('block');
    });
  });
});
