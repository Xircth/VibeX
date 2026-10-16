import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_BROWSER_SETTINGS,
  evaluateHostRules,
  matchHostRule,
  normalizeBrowserSettings,
  parseHostRulePattern,
  resetBrowserPrefsForTests,
  resolveLinkOpenAction,
  resolveSiteRuleAction,
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
      expect(validateHostRulePattern('*')).toBeNull();
      expect(validateHostRulePattern('example.com:*')).toBeNull();

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
      expect(
        evaluateHostRules(rules, 'https://app.example.com/dashboard')
      ).toBe('builtin');
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
      expect(
        matchHostRule(
          'https://*.example.com:8443',
          'https://a.example.com:8443/login'
        )
      ).toBe(true);
      expect(
        matchHostRule(
          'https://*.example.com:8443',
          'http://a.example.com:8443/login'
        )
      ).toBe(false);
      expect(matchHostRule('*', 'https://anywhere.test/path')).toBe(true);
      expect(matchHostRule('[::1]:8080', 'http://[::1]:8080/app')).toBe(true);
      expect(matchHostRule('[0:0:0:0:0:0:0:1]', 'http://[::1]/')).toBe(true);
      expect(matchHostRule('example.com:*', 'https://example.com:8443/x')).toBe(
        true
      );
    });

    it('lets a more specific host beat a broader block, and block win ties', () => {
      expect(
        evaluateHostRules(
          [
            { pattern: '*.example.com', action: 'block' },
            { pattern: 'app.example.com', action: 'builtin' },
          ],
          'https://app.example.com/'
        )
      ).toBe('builtin');
      expect(
        evaluateHostRules(
          [
            { pattern: '*.example.com', action: 'block' },
            { pattern: 'app.example.com', action: 'builtin' },
          ],
          'https://other.example.com/'
        )
      ).toBe('block');
      expect(
        evaluateHostRules(
          [
            { pattern: 'dup.example', action: 'builtin' },
            { pattern: 'dup.example', action: 'block' },
          ],
          'https://dup.example/'
        )
      ).toBe('block');
      expect(
        evaluateHostRules(
          [
            { pattern: '*', action: 'system' },
            { pattern: 'keep.example', action: 'builtin' },
          ],
          'https://keep.example/'
        )
      ).toBe('builtin');
      expect(
        evaluateHostRules(
          [
            { pattern: '*', action: 'system' },
            { pattern: 'keep.example', action: 'builtin' },
          ],
          'https://other.example/'
        )
      ).toBe('system');
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
    it('uses one default opener and still applies hostRules overrides', () => {
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
      ).toBe('builtin');
      expect(
        resolveLinkOpenAction(
          'https://localhost:5173',
          'notification',
          settings
        )
      ).toBe('builtin');
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

      const systemDefault = normalizeBrowserSettings({
        defaultTarget: {
          transcript: 'system',
          toolCard: 'builtin',
          terminal: 'ask',
          editor: 'builtin',
          notification: 'builtin',
        },
      });
      expect(
        resolveLinkOpenAction('https://localhost:5173', 'editor', systemDefault)
      ).toBe('system');
    });
  });

  describe('resolveSiteRuleAction', () => {
    it('follows site rules and leaves unmatched addresses in the built-in browser', () => {
      const settings = normalizeBrowserSettings({
        defaultTarget: {
          transcript: 'system',
          toolCard: 'system',
          terminal: 'system',
          editor: 'system',
          notification: 'system',
        },
        hostRules: [
          { pattern: 'keep.example', action: 'builtin' },
          { pattern: 'blocked.example', action: 'block' },
        ],
      });
      expect(resolveSiteRuleAction('https://keep.example/', settings)).toBe(
        'builtin'
      );
      expect(resolveSiteRuleAction('https://blocked.example/', settings)).toBe(
        'block'
      );
      expect(resolveSiteRuleAction('https://other.example/', settings)).toBe(
        null
      );
    });
  });
});
