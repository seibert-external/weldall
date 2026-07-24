-- Better Auth 1.7 identifies external accounts by issuer and provider subject.
ALTER TABLE "Account" RENAME COLUMN "accountId" TO "providerAccountId";

ALTER TABLE "Account" ADD COLUMN "issuer" TEXT;

-- Google is the only social provider configured by Weldall.
UPDATE "Account"
SET "issuer" = 'https://accounts.google.com'
WHERE "providerId" = 'google';

ALTER TABLE "Account" ALTER COLUMN "issuer" SET NOT NULL;

CREATE UNIQUE INDEX "Account_issuer_providerAccountId_key"
ON "Account"("issuer", "providerAccountId");
