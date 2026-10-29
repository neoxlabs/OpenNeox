
import { Scope } from '../../../ide/scope/Scope.js';

export class AppScope extends Scope {
  constructor() {
    super({ parent: null, level: 'app' });
  }
}
