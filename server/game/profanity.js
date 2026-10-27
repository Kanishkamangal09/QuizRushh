// small blocklist, not meant to be perfect
const words = [
  'fuck', 'shit', 'bitch', 'asshole', 'bastard', 'dick', 'cunt', 'slut', 'whore',
  'nigger', 'nigga', 'faggot', 'retard', 'rape', 'nazi', 'porn', 'penis', 'vagina',
];

const swaps = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', '@': 'a', $: 's', '!': 'i' };

export function isClean(nickname) {
  const squashed = nickname
    .toLowerCase()
    .replace(/[013457@$!]/g, (c) => swaps[c])
    .replace(/[^a-z]/g, '');
  return !words.some((w) => squashed.includes(w));
}
