'use strict';

/**
 * writeOwnership.js
 * -----------------------------------------------------------------------
 * One project owns every write to shared systems (OEM review 19 Nov 2026,
 * 4.4). The same code can run in two Catalyst projects (the trial and MG AU);
 * locks in separate projects do not coordinate, so both could write to the
 * same OEM CRM and dealer CRMs. With LEAD_EXCHANGE_OWNER_PROJECT_ID set, every
 * write boundary calls assertWriteOwner() first:
 *   - OEM CRM data writes   (zohoCrmService.updateOemLead)
 *   - dealer CRM writes     (crmIntegrationService.attemptExternalCrmSync)
 *   - Zoho watch channels   (zohoWebhookService register / renew / delete)
 * A project whose runtime id is not the owner, or cannot be read, is refused
 * with WRITE_OWNERSHIP_DENIED before any request is sent. Unset: no check.
 */

const { getWriteOwnerProjectId } = require('../config/env');
const usageContext = require('./usageContext');

/** { projectId, environment } of the running request, or nulls when unknown. */
function currentProject() {
  const project = usageContext.current()?.catalystProject;
  return {
    projectId: project?.projectId || null,
    environment: project?.environment || null,
  };
}

function isWriteOwner() {
  const owner = getWriteOwnerProjectId();
  if (!owner) return true;
  return currentProject().projectId === owner;
}

/**
 * @param {string} target what was about to be written (for the error only).
 * @throws WRITE_OWNERSHIP_DENIED when this project does not own writes.
 */
function assertWriteOwner(target) {
  if (isWriteOwner()) return;
  const { projectId } = currentProject();
  throw Object.assign(
    new Error(
      `Write to ${target} refused: this project (${projectId || 'unknown'}) is not LEAD_EXCHANGE_OWNER_PROJECT_ID`
    ),
    { code: 'WRITE_OWNERSHIP_DENIED', nonRetryable: true }
  );
}

module.exports = { assertWriteOwner, isWriteOwner, currentProject };
