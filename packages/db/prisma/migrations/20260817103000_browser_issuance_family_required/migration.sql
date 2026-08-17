-- Every claimed browser issuance owns its final refresh-family identity from
-- the atomic APPROVED -> ISSUING transition onward.
ALTER TABLE "BrowserConnectionIssuanceAttempt"
  ALTER COLUMN "refreshFamilyId" SET NOT NULL;
