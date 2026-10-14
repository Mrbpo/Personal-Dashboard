import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

// Expectations are authored from the PDF's independent Poppler/Tesseract reference,
// before retrieval. Never derive expected documents/pages from search results.
const probability=[
 [1,1,'How does knowing the first coin toss was heads change three-heads probability?','the first toss was heads',[2]],
 [1,3,'What is the chance the second card is a spade after drawing a spade?','51 cards remaining',[2]],
 [1,4,'When may a sample-space partition be used in the law of total probability?','disjoint and cover'],
 [1,5,'How does adding an opposite-color ball change the second-red-ball probability?','a red ball is added'],
 [1,6,'How are branch probabilities combined along a probability-tree path?','product of the probabilities'],
 [1,7,'Why can a coin landing in honey invalidate independent repeated experiments?','coin lands in honey'],
 [1,8,'Are a playing card being an ace and being a heart independent?','independent of'],
 [1,8,'Why is a probability-zero event independent of itself?','independent of itself'],
 [1,9,'What false positive and false negative rates are used in the screening example?','routine screening test'],
 [1,10,'Why does high test accuracy not imply high probability of disease after a positive result?','95% of positive tests'],
 [2,2,'What does a random variable assign to each sample-space outcome?','assigns a number'],
 [2,3,'How is the probability mass function of the maximum of two dice tabulated?','maximum value of the two dice'],
 [2,4,'How is a cumulative distribution function built from probability mass values?','accumulates by adding'],
 [2,5,'Why must a cumulative distribution function be non-decreasing?','non-decreasing'],
 [2,6,'Which distribution models one trial with success or failure?','models one trial'],
 [2,7,'Which distribution counts successes in independent Bernoulli trials?','independent Bernoulli'],
 [2,8,'How many sequences give two heads in five flips in the binomial calculation?','list has 10 entries'],
 [2,9,'Which distribution counts tails before the first head?','tails before the first head'],
 [2,10,'How is the number of boys before the first girl modeled for island families?','inhabitants of an island'],
 [2,12,'How can the probability table of a sum of two independent variables be constructed?','two-dimensional table'],
 [3,1,'Why do equal means fail to describe differences in spread?','both have mean'],
 [3,2,'Why does variance average squared distances from the mean?','weighted average'],
 [3,2,'What are the units of variance when a random variable is measured in meters?','meters squared'],
 [3,4,'What is the variance of a Bernoulli random variable?','variance of a Bernoulli'],
 [3,5,'Why cannot independence be used when calculating the variance of X plus itself?','not independent of itself'],
 [3,6,'How is the variance scaling property proved using expectation algebra?','Proof of Property 2'],
 [4,2,'What is meant by likelihood in the hundred coin flips example?','55 heads'],
 [4,3,'Why do likelihood and log likelihood have the same maximizing parameter?','maxima of the likelihood'],
 [4,4,'How is an exponential lifetime parameter estimated from five Badger light bulbs?','Badger brand light bulbs'],
 [4,5,'Which endpoints maximize the likelihood of a uniform distribution?','must include all the data'],
 [4,6,'How does the capture recapture likelihood estimate the wild animal population?','4 out of 20 recaptured'],
 [4,6,'How are Hardy Weinberg allele frequencies estimated from genotype counts?','diploid genotype'],
 [4,8,'How does the maximum likelihood estimate behave under one-to-one transformations?','one-to-one function'],
 [5,2,'How does one observed datum select a column in a Bayesian likelihood table?','data picks out one column'],
 [5,3,'How is a continuous prior represented when binomial hypotheses range from zero to one?','continuous range of values'],
 [5,4,'What does a posterior density mean when both parameter and data are continuous?','small interval of size'],
 [5,5,'Why can using the same letter for data and hypothesis densities cause confusion?','same letter'],
 [5,6,'Why can the normal posterior be identified without computing total probability?','used for normalization'],
 [5,8,'How is posterior predictive density obtained from the previous posterior?','posterior predictive pdf'],
 [6,2,'What does a significance level of 0.05 actually say about mistakes?','null hypothesis is true'],
 [6,3,'What assumptions must be checked before comparing two groups with a significance test?','same variance'],
 [6,4,'When is a z test appropriate for normal data?','known variance'],
 [6,5,'Why does a two-sided z test have a factor of two in its p value?','Reason for the factor of 2'],
 [6,6,'When should the Studentized mean replace the standardized mean?','Studentized mean'],
 [6,8,'How is pooled variance used in a two sample t test?','pooled variance'],
 [7,2,'Why does frequentist inference not give the probability of a hypothesis?','never uses or gives'],
 [7,3,'How can different priors be used to examine sensitivity of Bayesian conclusions?','trying different priors'],
 [7,4,'Why must frequentist experimental design specify the analysis before collecting data?','helps control for experimenter bias'],
 [7,5,'Why can coin experiment stopping rules give opposite frequentist conclusions?','opposite conclusions'],
 [7,6,'How does a utility function express different attitudes to investment risk?','tolerance for risk'],
];

const mechanics=[
 [1,3,'How is an object position coordinate defined relative to an origin?','position coordinate is a function of time'],
 [1,4,'How does displacement relate to two position vectors?','vector difference between'],
 [1,5,'How does the tangent slope define instantaneous velocity?','slope of the line connecting'],
 [1,8,'What does the Mean Value Theorem guarantee about instantaneous and average velocity?','exists an instant in time'],
 [1,9,'How is average acceleration defined over a time interval?','change in velocity'],
 [1,12,'Why is the area under a constant-acceleration velocity graph a trapezoid?','formed from a rectangle'],
 [1,15,'How is a car catching a constant-speed bus modeled?','Catching a Bus'],
 [1,24,'What piecewise acceleration is used for the braking car and bicycle problem?','Bicycle and Car'],
 [2,3,'What causes the actual projectile orbit to differ from the parabolic orbit?','accounting for air resistance'],
 [2,4,'How is initial projectile velocity decomposed into horizontal and vertical components?','Decompose the initial velocity'],
 [2,5,'What force diagram is used when projectile air resistance is neglected?','neglecting all forces'],
 [2,6,'Why does horizontal projectile velocity remain unchanged during flight?','no horizontal forces'],
 [2,7,'How is the highest point of a stone thrown at 45 degrees calculated?','person throws a stone'],
 [2,9,'How is the maximal height of the thrown stone obtained?','maximal height of the stone'],
 [2,10,'How is the direction of projectile velocity found from component velocities?','direction of the velocity vector'],
 [2,11,'Why must a thrown ball aimed at a released pail still hit it?','Hitting the Bucket'],
 [3,4,'Why do simultaneously applied forces add as vectors?','forces add as vectors'],
 [3,5,'How is the ground force balancing a rope-supported post calculated?','sum of the forces due to the ropes'],
 [3,6,'How is inertial mass determined using acceleration ratios?','ratios of the acceleration'],
 [3,6,'What is Newton first law also called?','Principle of Inertia'],
 [3,7,'How did Newton define the quantity of motion?','velocity and quantity of matter'],
 [3,8,'How does Newton second law simplify when mass stays constant?','mass remains constant'],
 [3,9,'What relation holds between the forces two interacting objects exert?','same magnitude of force'],
 [4,7,'How is the final momentum of a freight car loaded with coal calculated?','coal of mass'],
 [4,8,'What momentum diagram is used for a freight car losing sand?','sand leaves'],
 [4,10,'How is a freight car filled with grain from another moving car modeled?','Filling a Freight Car'],
 [4,14,'What system should be chosen when a jet of water strikes a boat?','total momentum constant'],
 [4,18,'Why does only part of a moving jet of water enter the boat?','Only a fraction'],
 [4,22,'Why is rocket thrust a consequence of fuel ejection rather than an extra force?','not an extra force'],
 [4,23,'What is the role of the rocket dry mass in its final speed?','final dry mass'],
 [4,24,'How is final speed found for a single-stage rocket in empty space?','Single-Stage Rocket'],
 [4,25,'Why can a two-stage rocket reach a greater speed than a one-stage rocket?','greater than if the fuel'],
 [5,6,'Which molecular motion is counted as kinetic energy of a body?','coherent motion of molecules'],
 [5,11,'Is work a scalar quantity and what SI unit does it use?','Work is a scalar quantity'],
 [5,15,'How is work from a variable force related to an area under a curve?','work integral is the area'],
 [5,15,'How is work done by a spring on a frictionless table calculated?','Work done by the Spring Force'],
 [5,20,'How can gravitational average power be computed from force and velocity?','average power is therefore'],
 [5,23,'When can the scalar product of two vectors be negative?','depending on the value'],
 [5,29,'Why is a work line integral independent of dividing the time interval?','independent of the way we divide'],
 [5,33,'How is work by the inverse square gravitational force obtained along an orbit?','Inverse Square Gravitation Force'],
 [5,37,'How does internal-force work change a two-particle system relative kinetic energy?','square of the relative velocity'],
 [6,4,'Which two forms constitute mechanical energy?','kinetic energy and potential energy'],
 [6,10,'How is change in internal potential energy defined for two interacting objects?','negative of the work done'],
 [6,12,'Why is gravity internal to the chosen falling-object and Earth system?','internal conservative force'],
 [6,14,'Which reference position makes spring potential energy zero?','equilibrium position of the spring'],
 [6,17,'How is conservative force recovered from the derivative of potential energy?','force is the negative derivative'],
 [6,18,'Why does positive potential-energy curvature make a minimum stable?','positive curvature'],
 [6,25,'How is escape velocity from the asteroid Toro calculated?','Escape Velocity of Toro'],
 [6,44,'Why do vibrational modes contribute two degrees of freedom?','extra factor of two'],
 [6,54,'Does classical theory match the temperature-dependent hydrogen molar specific heat?','classical theory does not agree'],
];

const numerical=[
 [1,1,'How is interpolation approximation accuracy traded against computational cost?','Approximation ovceuracy'],
 [1,2,'Which endpoint defines piecewise constant left-endpoint interpolation?','Evdpowit'],
 [1,3,'How does a first derivative bound control piecewise constant interpolation error?','Evvor Analysis'],
 [1,3,'What does convergence rate order mean for interpolation as mesh width decreases?','comergence rate'],
 [1,4,'How does slope in a log error versus number of segments plot describe convergence?','slope umber'],
 [1,5,'What is a FLOP in an operation count?','Floating wt Ockons'],
 [1,6,'How does piecewise linear interpolation use values at both interval endpoints?','Mecanse Lame'],
 [1,7,'What convergence order does piecewise linear interpolation achieve?','picaoise Lmear second Oder'],
 [1,8,'Why does rapid function variation motivate higher order interpolation?','rapid variation'],
 [2,1,'How can interpolation be used to construct a numerical integration rule?','Interped ehove to Lloegr'],
 [2,2,'What error order is expected for the left rectangle integration rule?','Rectangle Rul'],
 [2,2,'How can a bound on interpolation error give a bound on quadrature error?','terpchact Net'],
 [2,3,'How does triangular area give the local rectangle quadrature error for a linear integrand?','Figorous sult'],
 [2,4,'What convergence order does the trapezoidal integration rule attain?','Traxezeidal Rule'],
 [2,4,'How many function evaluations are required at the quadrature nodes?','Function evaluatons'],
 [2,5,'How are quadrature weights changed when interval widths are not uniform?','Varade dh'],
 [2,6,'How can higher order interpolation generate improved quadrature rules?','higher order'],
 [3,1,'What do the possible outcomes of a heat transfer coursework experiment represent?','all posible oultemes'],
 [3,2,'How are total frequencies obtained by counting all experiment outcomes?','Tot Frequemcres'],
 [3,2,'Why are taken and not-taken coursework events mutually exclusive?','mutually exclusive'],
 [3,2,'Why are the two coursework background events collectively exhaustive?','collectvely exhaustve'],
 [3,3,'How does inclusion exclusion correct a union count for overlapping events?','zero mutually exclusive'],
 [3,3,'Which sample denominator is used for conditional frequency of a correct answer?','those students who have Taken'],
 [3,4,'How does Bayes theorem reverse coursework and answer conditional frequencies?','Baye Theorawe'],
 [3,5,'How are limiting sample frequencies used to define population probabilities?','In principle'],
 [4,3,'How does transposing a matrix exchange its rows and columns?','Switch rows avd columns'],
 [4,3,'How is vector addition defined through corresponding components?','add cowrespondina'],
 [4,4,'How does an inner product test whether vectors are orthogonal?','dot product'],
 [4,4,'How is the Euclidean two norm defined from an inner product?','Eadlidean norm'],
 [4,4,'What size condition is needed before two matrices can be multiplied?','Muth lication'],
 [4,5,'How is matrix vector multiplication viewed as row inner products?','vos perspectue'],
 [4,6,'How is a matrix vector product a linear combination of columns?','linear comonaton'],
 [4,6,'Which distributive and associative matrix product rules hold?','Matrix Rules'],
 [4,6,'Why does matrix multiplication generally fail to commute?','AB BA'],
 [4,7,'Is explicitly forming a matrix inverse recommended for solving a linear system?','COMPUTAM ONAL APPROAGH'],
 [5,1,'How is a pendulum model linearized for small initial angular displacement?','small tial'],
 [5,2,'Which unsteady heat transfer example motivates an initial value problem?','Unsteady Year Taner'],
 [5,3,'Which backward Euler scheme is used for the model initial value ODE?','Euler Badewardt'],
 [5,5,'Why is backward Euler implicit at the new time level?','Tmphert scheme'],
 [5,5,'How does a Taylor expansion establish the consistency error of an ODE scheme?','CONSISPEEY'],
 [5,6,'Why is backward Euler unconditionally stable for a negative model coefficient?','UNcovprrioNAL STABILITY'],
 [5,7,'How does the forward Euler scheme use the left rectangle rule?','Guler Four'],
 [5,9,'What step-size restriction gives forward Euler conditional stability?','CouprriowAL STABILITY'],
 [5,10,'Why can an overly large Euler forward step produce blow-up?','bleu-up'],
 [6,1,'How does Newton method use a tangent linear approximation to update a root?','Newton s Method'],
 [6,2,'How is function residual tolerance used to stop Newton iterations?','Newton algorithm without storage'],
 [6,3,'What smoothness and initial-guess conditions ensure quadratic Newton convergence?','derivative at the root is nonzero'],
 [6,4,'Why does a zero derivative at a root slow Newton convergence?','slower convergence'],
 [6,6,'What derivative matrix is used in multivariate Newton iteration?','Vacchien matrix'],
 [6,7,'Which linearized system is solved at each multivariate Newton iteration?','Solve the linearized system'],
];

function normalize(value){return value.normalize('NFKC').toLowerCase().replace(/([a-z])-\s*\n\s*([a-z])/g,'$1$2').replace(/[^a-z0-9]+/g,' ').trim();}

export async function buildPdfSearchQuestions(root,manifest){
 const references=new Map();
 for(const item of manifest){
  const engine=item.group==='numerical'?'tesseract-independent':'poppler-independent';
  const suffix=item.group==='numerical'?'.reference-ocr.json':'.reference.json';
  references.set(item.path,{item,engine,pages:JSON.parse(await readFile(join(root,item.path+suffix),'utf8'))});
 }
 const questions=[],anchorErrors=[];
 for(const [group,seeds] of Object.entries({numerical,probability,mechanics})){
  if(seeds.length!==50)throw new Error(`${group}: exactly 50 independent content questions required, got ${seeds.length}`);
  for(const [index,[number,page,query,anchor,additionalPages=[]]] of seeds.entries()){
   const path=`${group}-${String(number).padStart(2,'0')}.pdf`,reference=references.get(path),raw=reference.pages[page-1];
   const at=normalize(raw||'').indexOf(normalize(anchor));
   if(at<0){anchorErrors.push(`${group}-${index+1}: ${path} page ${page}: ${anchor}`);continue;}
   const expectedPages=[page,...additionalPages];
   const normalized=normalize(raw),excerpt=normalized.slice(Math.max(0,at-100),at+normalize(anchor).length+150);
   questions.push({id:`${group}-${String(index+1).padStart(2,'0')}`,group,query,expected:[{path,pages:expectedPages}],
    reference:{engine:reference.engine,path,page,anchor,excerpt,sha256:reference.item.sha256,sourceUrl:reference.item.source_url}});
  }
 }
 if(anchorErrors.length)throw new Error(`Unverified independent anchors:\n${anchorErrors.join('\n')}`);
 return {schemaVersion:1,createdFrom:'Independent source PDF references; expectations authored before retrieval',
  queryLanguage:'English (same language as this public corpus)',questions,
  expectationSha256:createHash('sha256').update(JSON.stringify(questions)).digest('hex')};
}
