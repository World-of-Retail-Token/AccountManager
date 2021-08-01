'use strict';

import bip39 from 'bip39';
const mnemonic = bip39.generateMnemonic();

console.log(mnemonic);
