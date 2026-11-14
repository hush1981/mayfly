import { completeMention, mentionedIds, splitMentions, typingMention } from '../chat/mentions';

const members = [{ id: 'a', username: 'anna' }, { id: 'b', username: 'Bob_2' }];

describe('mentions', () => {
  it('finds mentioned members only', () => {
    expect(mentionedIds('hi @anna and @bob_2, not @carl or mail@anna', members).sort()).toEqual(['a', 'b']);
  });
  it('completes the typed prefix', () => {
    expect(typingMention('hey @an')).toBe('an');
    expect(typingMention('hey @')).toBe('');
    expect(typingMention('hey an')).toBeNull();
    expect(completeMention('hey @an', 'anna')).toBe('hey @anna ');
  });
  it('splits for highlighting', () => {
    expect(splitMentions('@anna look', members)).toEqual([{ text: '@anna', mention: 'a' }, { text: ' look' }]);
    expect(splitMentions('x @nobody', members)).toEqual([{ text: 'x @nobody' }]);
  });
});
