const MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
const SYSTEM_PROMPT = `Sos el asistente de admisión técnica de Rider Service, un servicio de diagnóstico y reparación de motos, scooters y bicicletas eléctricas en Pilar y Zona Norte, Buenos Aires. Tu única tarea es reunir los datos necesarios para que el taller pueda evaluar y presupuestar una reparación.

Respondé SIEMPRE en español rioplatense, cordial, claro y breve. Mantené la conversación estrictamente dentro de la solicitud de reparación. Si la persona se desvía a otro tema, decí brevemente que podés ayudar con la solicitud de Rider Service y retomá la última pregunta pendiente. No sigas temas ajenos.

Hacé UNA sola pregunta concreta por turno. No repitas preguntas ya respondidas. Reuní, de forma gradual: (1) tipo de vehículo, (2) marca y modelo, (3) año aproximado si lo sabe, (4) problema principal y cuándo comenzó, (5) síntomas concretos y cuándo ocurre, (6) antecedentes relevantes como golpe, agua, modificación o reparación previa, (7) zona/localidad para coordinar, y (8) nombre y contacto solo si la persona acepta compartirlos. No exijas datos que no conozca; anotá "no informado".

Hacé preguntas adicionales solo si son relevantes para comprender la falla. No instruyas a abrir baterías, manipular alta corriente ni realizar pruebas peligrosas. Si menciona batería hinchada, humo, olor a quemado, chispas o calentamiento severo, recomendá dejar de usar/cargar el vehículo y solicitar revisión profesional.

No inventes diagnóstico, repuestos, disponibilidad, plazos ni precios. No afirmes que el presupuesto está calculado. Cuando haya información suficiente (vehículo + marca/modelo si lo conoce + falla + síntomas/contexto), podés preguntar una última vez si quiere agregar algún dato. Si responde que no, o ya está claro el caso, terminá la recopilación y generá un resumen estructurado. No sigas haciendo preguntas después de que la persona pida terminar.

Devolvé SOLAMENTE un objeto JSON válido, sin markdown ni texto adicional, con esta forma exacta:
{"message":"texto breve que verá el cliente","finished":false,"summary":""}
Al finalizar, finished=true y summary debe contener un resumen profesional en español con: vehículo, marca/modelo/año (si se informaron), problema, cuándo empezó, síntomas, antecedentes, localidad, contacto consentido, datos faltantes y una nota "Presupuesto pendiente de evaluación técnica; no es un precio confirmado". En el último turno, message debe confirmar que la solicitud quedó preparada y que puede enviar el resumen por WhatsApp. Si todavía falta información importante, finished=false y summary="" y message debe hacer una sola pregunta concreta.`;
function json(data,status=200){return new Response(JSON.stringify(data),{status,headers:{"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"}});}
function parseModelOutput(output){
  if(output && typeof output==="object"){
    if(typeof output.message==="string") return output;
    for(const key of ["response","output_text","text","content"]){
      if(typeof output[key]==="string"){const parsed=parseModelOutput(output[key]);if(parsed)return parsed;}
    }
    return null;
  }
  if(typeof output!=="string") return null;
  const cleaned=output.replace(/^```(?:json)?\s*/i,"").replace(/\s*```$/,"").trim();
  try{return JSON.parse(cleaned);}catch{}
  const start=cleaned.indexOf("{"),end=cleaned.lastIndexOf("}");
  if(start>=0&&end>start){try{return JSON.parse(cleaned.slice(start,end+1));}catch{}}
  // Si el modelo devuelve texto normal, permitir que la conversación continúe.
  if(cleaned && !cleaned.startsWith("{")) return {message:cleaned,finished:false,summary:""};
  return null;
}
export default {
  async fetch(request, env) {
    const url=new URL(request.url);
    if(url.pathname.startsWith("/api/")){
      if(url.pathname!=="/api/chat") return json({error:"Ruta no encontrada."},404);
      if(request.method!=="POST") return json({error:"Método no permitido."},405);
      const origin=request.headers.get("Origin");
      if(origin && origin!==url.origin) return json({error:"Origen no permitido."},403);
      const length=Number(request.headers.get("Content-Length")||0);
      if(length>16000) return json({error:"La conversación es demasiado larga. Iniciá una nueva solicitud."},413);
      let body;
      try{body=await request.json();}catch{return json({error:"Solicitud inválida."},400);}
      if(!Array.isArray(body.messages)||body.messages.length<1) return json({error:"Escribí una respuesta para continuar."},400);
      const messages=body.messages.slice(-14).filter(m=>m&&["user","assistant"].includes(m.role)&&typeof m.content==="string").map(m=>({role:m.role,content:m.content.slice(0,1200)}));
      if(!messages.length||messages[messages.length-1].role!=="user") return json({error:"No se pudo leer tu respuesta."},400);
      if(messages.reduce((n,m)=>n+m.content.length,0)>10000) return json({error:"La conversación es demasiado larga. Iniciá una nueva solicitud."},413);
      if(!env.AI){ console.error("RIDER_AI_BINDING_MISSING: env.AI no está disponible en esta versión del Worker"); return json({error:"El asistente no está disponible en este momento. Probá nuevamente más tarde."},503); }
      try{
        const result=await env.AI.run(MODEL,{messages:[{role:"system",content:SYSTEM_PROMPT},...messages],max_tokens:420,temperature:0.2,response_format:{type:"json_object"}});
        const parsed=parseModelOutput(result?.response||result?.output_text||"");
        if(!parsed||typeof parsed.message!=="string") return json({error:"No pude interpretar la respuesta. Probá enviar tu mensaje otra vez."},502);
        const finished=parsed.finished===true&&typeof parsed.summary==="string"&&parsed.summary.trim().length>0;
        return json({message:parsed.message.slice(0,1600),finished,summary:finished?parsed.summary.slice(0,5000):""});
      }catch(error){
        console.error("RIDER_AI_RUN_FAILED", {name: String(error?.name||"Error").slice(0,80), message: String(error?.message||error||"sin detalle").slice(0,300)});
        return json({error:"El asistente no está disponible en este momento. Probá nuevamente más tarde."},503);
      }
    }
    return env.ASSETS.fetch(request);
  }
};
