import {
  matchDollarCommandTrigger,
  matchFileReferenceTrigger,
  matchSlashCommandTrigger,
  matchTagReferenceTrigger,
} from './typeahead-triggers';

describe('typeahead trigger matching', () => {
  it.each([
    ['/', '', matchSlashCommandTrigger],
    ['$', '', matchDollarCommandTrigger],
    ['@', '', matchFileReferenceTrigger],
    ['#', '', matchTagReferenceTrigger],
    ['/comp', 'comp', matchSlashCommandTrigger],
    ['$plan', 'plan', matchDollarCommandTrigger],
    ['@src', 'src', matchFileReferenceTrigger],
    ['#bug', 'bug', matchTagReferenceTrigger],
  ] as const)(
    'matches %s at the start of the input',
    (text, query, matcher) => {
      expect(matcher(text)).toMatchObject({
        leadOffset: 0,
        matchingString: query,
        replaceableString: text,
      });
    }
  );

  it.each([
    ['hello /review', '/review', 'review', 6, matchSlashCommandTrigger],
    ['hello $plan', '$plan', 'plan', 6, matchDollarCommandTrigger],
    ['hello @src', '@src', 'src', 6, matchFileReferenceTrigger],
    ['hello #bug', '#bug', 'bug', 6, matchTagReferenceTrigger],
    ['hello (/review', '/review', 'review', 7, matchSlashCommandTrigger],
  ] as const)(
    'matches %s after whitespace or an opening paren',
    (text, replaceableString, query, offset, matcher) => {
      expect(matcher(text)).toMatchObject({
        leadOffset: offset,
        matchingString: query,
        replaceableString,
      });
    }
  );

  it('does not match inside an existing token', () => {
    expect(matchSlashCommandTrigger('hello/review')).toBeNull();
  });

  it('stops matching after whitespace in the query', () => {
    expect(matchSlashCommandTrigger('/review now')).toBeNull();
  });

  it('keeps trigger-specific query rules', () => {
    expect(matchSlashCommandTrigger('/ask@provider')).toMatchObject({
      matchingString: 'ask@provider',
    });
    expect(matchFileReferenceTrigger('@src/app.tsx')).toMatchObject({
      matchingString: 'src/app.tsx',
    });
    expect(matchFileReferenceTrigger('@src#tag')).toBeNull();
  });
});
