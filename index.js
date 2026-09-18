require('dotenv').config();
const {start}=require('./src/app');
start().catch(e=>{console.error(new Date().toISOString(),'[FATAL]',e.stack||e.message);process.exit(1);});
