// Shared settings live in platform-pkg-dev/vitest so they can be updated centrally.
// Vitest reads the config in the directory it runs from and does not walk up,
// so every package needs this file even inside a workspace.
import { devVitestConfig } from '@govuk-connect/dev/vitest';

export default devVitestConfig();
