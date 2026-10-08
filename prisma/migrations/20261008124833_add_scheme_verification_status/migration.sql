-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('SOURCE_CHECKED', 'COMPILED_UNVERIFIED');

-- AlterTable
ALTER TABLE "Scheme" ADD COLUMN     "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'COMPILED_UNVERIFIED';
