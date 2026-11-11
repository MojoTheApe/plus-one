// Cosmetic choices shared by the room and Territories; no gameplay statistics.
export const CHARACTERS = Object.freeze([
  { id: 'car', name: 'Автівка' },
  { id: 'cow', name: 'Корівка' },
  { id: 'crab', name: 'Краб' },
  { id: 'duck', name: 'Каченя' },
  { id: 'fox', name: 'Лисеня' },
  { id: 'penguin', name: 'Пінгвін' },
  { id: 'dino', name: 'Динозавр' },
  { id: 'robot', name: 'Робот' },
].map(character => Object.freeze(character)));

export const hasCharacter = value => CHARACTERS.some(character => character.id === value);
