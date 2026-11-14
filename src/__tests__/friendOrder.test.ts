jest.mock('../api/client', () => ({ apiClient: {} }));
jest.mock('../store/chatStore', () => ({ lastContactAt: () => 0, loadChatStore: async () => {} }));
jest.mock('../store/friendSet', () => ({ rememberFriends: () => {} }));

import { sortByLastContact } from '../api/friends';

describe('sortByLastContact', () => {
  const f = (id: string, username: string) => ({ id, username });
  it('puts the most recent contact first, the rest by name', () => {
    const at: Record<string, number> = { c: 100, b: 300 };
    const out = sortByLastContact([f('a', 'zoe'), f('b', 'max'), f('c', 'anna'), f('d', 'ben')], (id) => at[id] ?? 0);
    expect(out.map((x) => x.username)).toEqual(['max', 'anna', 'ben', 'zoe']);
  });
  it('does not change the input', () => {
    const list = [f('a', 'b'), f('b', 'a')];
    sortByLastContact(list, () => 0);
    expect(list[0].id).toBe('a');
  });
});
