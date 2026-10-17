/**
 * Reports page data from the server.
 */
import { pageData } from '../../core/dom.js';

export const data = pageData();
export const accountId = data.accountId;
export const workspace = data.workspace;
export const workspaceAvailable = Boolean(accountId && workspace);
