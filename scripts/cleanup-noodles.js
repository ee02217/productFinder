const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  // Find existing suggestions first
  const existing = await prisma.matchSuggestion.findMany({
    where: {
      retailer: 'pingodoce',
      sourceName: { contains: 'Noodles De Galinha', mode: 'insensitive' }
    }
  });
  console.log('Existing suggestions:', JSON.stringify(existing, null, 2));
  
  // Delete them
  const deleted = await prisma.matchSuggestion.deleteMany({
    where: {
      retailer: 'pingodoce',
      sourceName: { contains: 'Noodles De Galinha', mode: 'insensitive' }
    }
  });
  console.log('Deleted count:', deleted.count);
  
  await prisma.$disconnect();
}
main().catch(console.error);
