// Prompt templates used to embed catalog works and the generic negatives (build time only).
const T = {
  movie: ['a still from the movie {t}', 'the poster of the movie {t}', '{t}'],
  tv: ['a scene from the TV show {t}', 'the poster of the TV series {t}', '{t}'],
  game: ['a screenshot of the video game {t}', 'the cover art of the video game {t}', '{t}'],
  book: ['the cover of the book {t}', 'an illustration from {t}', '{t}'],
  anime: ['a scene from the anime {t}', 'the poster of the anime {t}', '{t}'],
  manga: ['a page from the manga {t}', 'the cover of the manga {t}', '{t}'],
  comic: ['a panel from the comic {t}', 'the cover of the comic {t}', '{t}'],
};
export const textPrompts = (w) => [
  ...(T[w.type] ?? T.movie).map((s) => s.replace('{t}', w.title)),
  ...(w.characters ?? []).slice(0, 2).map((c) => `${c} from ${w.title}`),
];
export const NEGATIVES = [
  'a photo', 'a photo of a person', 'a portrait photo of a woman', 'a portrait photo of a man', 'a selfie', 'a group of people',
  'a photo of a dog', 'a photo of a cat', 'a photo of an animal', 'a photo of food', 'a photo of a meal on a plate',
  'a landscape photo', 'a photo of mountains', 'a photo of the sea', 'a photo of a city street', 'a photo of a building',
  'a photo of a car', 'a photo of a bicycle', 'a photo of a room', 'a photo of an office', 'a laptop on a desk',
  'a screenshot of a website', 'a text document', 'a chart', 'a logo', 'a meme', 'a photo of a crowd at a concert',
  'a sports match', 'a photo of a castle', 'a photo of a park', 'a product photo', 'a drawing', 'a map',
];
// "Is this image media at all?" prompts. An image must look like media (beat the generic NEGATIVES by the
// media gate) before any title can match, so a wedding photo never becomes "The Wedding Singer".
export const MEDIA = [
  'a movie poster', 'a still frame from a movie', 'a black and white still from an old film', 'a scene from a TV series',
  'a screenshot of a video game', 'video game graphics', 'a pixel art video game screen', 'a 3D rendered animated film scene',
  'a cartoon', 'anime artwork', 'a manga page', 'a comic book panel', 'a book cover', 'a video game cover art',
  'a cosplayer dressed as a fictional character', 'a costumed character from a film', 'a film set', 'a theme park attraction based on a film',
  'a title card of a film', 'a movie trailer screenshot',
];
