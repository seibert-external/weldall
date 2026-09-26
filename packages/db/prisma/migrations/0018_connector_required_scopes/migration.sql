-- CreateTable
CREATE TABLE "ConnectorRequiredScope" (
    "connectorId" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,

    CONSTRAINT "ConnectorRequiredScope_pkey" PRIMARY KEY ("connectorId", "scopeId")
);

-- CreateIndex
CREATE INDEX "ConnectorRequiredScope_scopeId_idx" ON "ConnectorRequiredScope"("scopeId");

-- AddForeignKey
ALTER TABLE "ConnectorRequiredScope" ADD CONSTRAINT "ConnectorRequiredScope_connectorId_fkey" FOREIGN KEY ("connectorId") REFERENCES "Connector"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConnectorRequiredScope" ADD CONSTRAINT "ConnectorRequiredScope_scopeId_fkey" FOREIGN KEY ("scopeId") REFERENCES "Scope"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
