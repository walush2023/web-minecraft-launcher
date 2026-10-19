// OpenAL is not implemented yet: opening a device fails, so Minecraft logs
// "Error starting SoundSystem" and continues silently.
import { cstring } from './heap.js';
import { defineLibrary } from './registry.js';

export function defineOpenAL() {
  defineLibrary('openal', {
    aliases: ['libopenal.so', 'libopenal.so.1', 'OpenAL', 'soft_oal', 'openal32'],
    lenient: true,
    impls: {
      alcOpenDevice: () => 0,
      alcGetError: () => 0,
      alcGetString: () => cstring(''),
      alcIsExtensionPresent: () => 0,
      alGetError: () => 0,
      alcGetProcAddress: () => 0,
      alGetProcAddress: () => 0,
    },
  });
}
