import { useId, useState } from 'react'

type HelpTipProps = {
  text: string
  tone?: 'help' | 'warning'
  label?: string
  placement?: 'top' | 'bottom'
}

export function HelpTip({text,tone='help',label,placement='top'}:HelpTipProps) {
  const tipId=useId()
  const [open,setOpen]=useState(false)
  return <span className={`help-tip help-tip-${tone} help-tip-${placement}`} data-open={open} onMouseEnter={()=>setOpen(true)} onMouseLeave={()=>setOpen(false)}>
    <button type="button" className="help-tip-trigger" aria-label={label|| (tone==='warning'?'Atenção':'Ajuda')} aria-describedby={tipId}
      onFocus={()=>setOpen(true)} onBlur={()=>setOpen(false)} onClick={event=>{event.preventDefault();setOpen(value=>!value)}} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setOpen(false)}}}>
      <span className="help-tip-symbol" aria-hidden="true">{tone==='warning'?'!':'?'}</span>
    </button>
    <span className="help-tip-bubble" role="tooltip" id={tipId}>{text}</span>
  </span>
}

export function FieldLabel({children,help,warning}:{children:React.ReactNode;help:string;warning?:boolean}) {
  return <span className="field-label"><span>{children}</span><HelpTip text={help} tone={warning?'warning':'help'}/></span>
}
