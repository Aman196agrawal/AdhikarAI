-- CreateEnum
CREATE TYPE "CatalogStatus" AS ENUM ('ACTIVE', 'WITHDRAWN');

-- CreateEnum
CREATE TYPE "CatalogDraftStatus" AS ENUM ('PENDING', 'DRAFTED', 'FAILED');

-- CreateEnum
CREATE TYPE "CatalogRuleStatus" AS ENUM ('DRAFT', 'APPROVED', 'REJECTED', 'STALE');

-- CreateEnum
CREATE TYPE "SyncRunStatus" AS ENUM ('RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED');

-- CreateTable
CREATE TABLE "CatalogScheme" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameHi" TEXT,
    "shortTitle" TEXT,
    "level" TEXT NOT NULL,
    "states" TEXT[],
    "categories" TEXT[],
    "ministry" TEXT,
    "tags" TEXT[],
    "schemeFor" TEXT,
    "closesOn" TIMESTAMP(3),
    "briefDescription" TEXT NOT NULL,
    "eligibilityMd" TEXT,
    "benefitsMd" TEXT,
    "exclusionsMd" TEXT,
    "documentsMd" TEXT,
    "applicationProcessMd" TEXT,
    "hindi" JSONB,
    "facets" JSONB NOT NULL DEFAULT '{}',
    "officialUrl" TEXT NOT NULL,
    "referenceUrls" TEXT[],
    "contentHash" TEXT NOT NULL,
    "status" "CatalogStatus" NOT NULL DEFAULT 'ACTIVE',
    "firstSeenAt" TIMESTAMP(3) NOT NULL,
    "lastFetchedAt" TIMESTAMP(3) NOT NULL,
    "lastChangedAt" TIMESTAMP(3) NOT NULL,
    "withdrawnAt" TIMESTAMP(3),
    "missingSyncCount" INTEGER NOT NULL DEFAULT 0,
    "unmappedCriteria" TEXT[],
    "draftStatus" "CatalogDraftStatus" NOT NULL DEFAULT 'PENDING',
    "trackedSchemeCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogScheme_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogSnapshot" (
    "id" TEXT NOT NULL,
    "catalogSchemeId" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,

    CONSTRAINT "CatalogSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogRule" (
    "id" TEXT NOT NULL,
    "catalogSchemeId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "kind" "ClauseKind" NOT NULL,
    "field" TEXT NOT NULL,
    "op" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "mandatory" BOOLEAN NOT NULL DEFAULT true,
    "text" TEXT NOT NULL,
    "sourceQuote" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "status" "CatalogRuleStatus" NOT NULL DEFAULT 'DRAFT',
    "draftedBy" TEXT NOT NULL,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SchemeSyncRun" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "status" "SyncRunStatus" NOT NULL DEFAULT 'RUNNING',
    "startedAt" TIMESTAMP(3) NOT NULL,
    "finishedAt" TIMESTAMP(3),
    "listed" INTEGER NOT NULL DEFAULT 0,
    "created" INTEGER NOT NULL DEFAULT 0,
    "changed" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "withdrawn" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "drafted" INTEGER NOT NULL DEFAULT 0,
    "errors" JSONB NOT NULL DEFAULT '[]',
    "note" TEXT,

    CONSTRAINT "SchemeSyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CatalogScheme_status_level_idx" ON "CatalogScheme"("status", "level");

-- CreateIndex
CREATE INDEX "CatalogScheme_draftStatus_idx" ON "CatalogScheme"("draftStatus");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogScheme_source_externalId_key" ON "CatalogScheme"("source", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogSnapshot_catalogSchemeId_contentHash_key" ON "CatalogSnapshot"("catalogSchemeId", "contentHash");

-- CreateIndex
CREATE INDEX "CatalogRule_status_idx" ON "CatalogRule"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogRule_catalogSchemeId_code_key" ON "CatalogRule"("catalogSchemeId", "code");

-- AddForeignKey
ALTER TABLE "CatalogSnapshot" ADD CONSTRAINT "CatalogSnapshot_catalogSchemeId_fkey" FOREIGN KEY ("catalogSchemeId") REFERENCES "CatalogScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogRule" ADD CONSTRAINT "CatalogRule_catalogSchemeId_fkey" FOREIGN KEY ("catalogSchemeId") REFERENCES "CatalogScheme"("id") ON DELETE CASCADE ON UPDATE CASCADE;
