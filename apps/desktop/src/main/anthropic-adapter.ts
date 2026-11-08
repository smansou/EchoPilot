/** Translate the app's internal chat/tool contract to Claude Messages. */
export function anthropicRequest(input:any){
 const system=input.messages.filter((m:any)=>m.role==='system').map((m:any)=>m.content).join('\n')+(input.response_format?'\nReturn only valid JSON, with no Markdown fencing.':'');
 const messages=input.messages.filter((m:any)=>m.role!=='system').map((m:any)=>{
  if(m.role==='tool')return {role:'user',content:[{type:'tool_result',tool_use_id:m.tool_call_id,content:m.content}]};
  const content:any[]=typeof m.content==='string'?(m.content?[{type:'text',text:m.content}]:[]):Array.isArray(m.content)?m.content.map((part:any)=>{
   if(part.type==='text')return part;
   const match=/^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(part.image_url?.url||'');
   if(!match)throw Error('Unsupported image source for Claude.');return {type:'image',source:{type:'base64',media_type:match[1],data:match[2]}};
  }):[];
  for(const call of m.tool_calls||[])content.push({type:'tool_use',id:call.id,name:call.function.name,input:JSON.parse(call.function.arguments)});
  return {role:m.role,content};
 });
 return {model:input.model,max_tokens:input.max_tokens||1800,system,messages,...(input.tools?{tools:input.tools.map((t:any)=>({name:t.function.name,description:t.function.description,input_schema:t.function.parameters}))}:{})};
}
export function anthropicResponse(value:any){
 if(!Array.isArray(value.content))throw Error('Claude returned an invalid response.');
 const text=value.content.filter((p:any)=>p.type==='text').map((p:any)=>p.text).join('');
 const tools=value.content.filter((p:any)=>p.type==='tool_use').map((p:any)=>({id:p.id,type:'function',function:{name:p.name,arguments:JSON.stringify(p.input)}}));
 return {choices:[{finish_reason:value.stop_reason==='tool_use'?'tool_calls':value.stop_reason==='end_turn'?'stop':value.stop_reason,message:{content:text||null,...(tools.length?{tool_calls:tools}:{})}}]};
}
