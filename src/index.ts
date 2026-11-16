/* Copyright (c) 2024, Oracle and/or its affiliates.
 * Licensed under the Universal Permissive License v1.0 as shown at https://oss.oracle.com/licenses/upl.
 */
import * as core from '@actions/core'

import { loginOcir, logoutOcir } from './main.js'

if (core.getState('logout') === 'true') {
  logoutOcir(core.getState('registry'))
} else {
  void loginOcir()
}
