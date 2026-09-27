import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { calculateOptimalSchedule, WEEKDAY_PEAK_WINDOWS, WEEKEND_PEAK_WINDOWS } from '../server/services/smart-scheduler.ts'
import { organizationScheduleHistory } from '../server/services/schedule-history.ts'
import { localInstant, businessDate, localParts } from '../server/lib/timezone.ts'

const originalRandom=Math.random,originalTZ=process.env.TZ
try{
  Math.random=()=>0.5
  const referenceDate=new Date('2026-06-15T12:00:00Z')
  let expected
  for(const hostZone of ['UTC','America/Sao_Paulo','Asia/Tokyo']){
    process.env.TZ=hostZone
    const scheduled=calculateOptimalSchedule({referenceDate})
    assert.equal(scheduled.isoString,'2026-06-15T15:15:25.000Z')
    expected??=scheduled.isoString
    assert.equal(scheduled.isoString,expected)
    assert(scheduled.scheduledAt.getTime()>=referenceDate.getTime()+10*60000)
    assert.equal(businessDate('2026-06-16 01:00:00'),'2026-06-15')
  }
  const day=new Date('2026-06-15T00:00:00Z')
  assert.equal(localInstant(day,17*60+65).toISOString(),'2026-06-15T21:05:00.000Z')
  assert.equal(localInstant(day,24*60+5).toISOString(),'2026-06-16T03:05:00.000Z')
  assert.equal(localInstant(day,-5).toISOString(),'2026-06-15T02:55:00.000Z')
  const existing=[]
  for(let offset=0;offset<7;offset++){
    const date=new Date(day.getTime()+offset*86400000)
    for(const win of [0,6].includes(date.getUTCDay())?WEEKEND_PEAK_WINDOWS:WEEKDAY_PEAK_WINDOWS){
      existing.push(localInstant(date,win.startHour*60+win.startMin).getTime())
    }
  }
  // Occupy the fallback as well; every path must enforce spacing.
  const ref=new Date('2026-06-15T03:00:00Z')
  existing.push(ref.getTime()+42*60000)
  const fallback=calculateOptimalSchedule({referenceDate:ref,existingTimestamps:existing})
  assert.equal(fallback.window,'Slot Adaptativo Livre')
  assert(existing.every(time=>Math.abs(time-fallback.scheduledAt.getTime())>=25*60000))
  const historicalData=Array.from({length:5},(_,i)=>({dayOfWeek:1,hour:12+i,successCount:10-i}))
  const historical=calculateOptimalSchedule({referenceDate:new Date('2026-06-15T15:00:00Z'),historicalData})
  assert.equal(historical.isoString,'2026-06-15T15:15:00.000Z','A same-hour slot still in the future must not be delayed a week')
  assert.throws(()=>calculateOptimalSchedule({minDelayMinutes:-1}))
  const db=new DatabaseSync(':memory:')
  db.exec('CREATE TABLE publication_jobs (organization_id INTEGER,status TEXT,filled_at TEXT)')
  const yesterday=new Date(Date.now()-86400000)
  const midnightUTC=new Date(Date.UTC(yesterday.getUTCFullYear(),yesterday.getUTCMonth(),yesterday.getUTCDate(),1))
  db.prepare('INSERT INTO publication_jobs VALUES (1,\'completed\',?)').run(midnightUTC.toISOString())
  db.prepare('INSERT INTO publication_jobs VALUES (2,\'completed\',?)').run(midnightUTC.toISOString())
  const p=localParts(midnightUTC)
  const history=organizationScheduleHistory(db,1)
  assert.deepEqual(history,[{dayOfWeek:new Date(Date.UTC(p.year,p.month-1,p.day)).getUTCDay(),hour:22,successCount:1}])
  db.close()
  console.log('✓ Fuso independente do host, histórico, overflow, atraso mínimo e colisões inclusive no fallback.')
}finally{Math.random=originalRandom;if(originalTZ===undefined)delete process.env.TZ;else process.env.TZ=originalTZ}
