-- Accounts: password hashes + one session row per signed-in device.

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep everyone who is currently signed in signed in.
INSERT INTO "Session" ("id", "userId", "tokenHash", "createdAt", "lastSeenAt")
SELECT 'legacy_' || "id", "id", "sessionTokenHash", "createdAt", "lastSeenAt" FROM "User";

-- AlterTable
DROP INDEX "User_sessionTokenHash_key";
ALTER TABLE "User" DROP COLUMN "sessionTokenHash",
ADD COLUMN     "passwordHash" TEXT;
